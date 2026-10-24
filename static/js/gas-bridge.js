/**
 * ============================================================
 *  gas-bridge.js — GitHub Pages ⇄ Google Apps Script 無縫橋接器
 * ============================================================
 *  功能：
 *  1. 當設定了 GAS_WEB_APP_URL 時，自動將所有 fetch('/api/...') 轉發至
 *     Google Apps Script Web App (使用 text/plain POST 避開 CORS 預檢問題)。
 *  2. 自動附加後台管理員 Token (localStorage) 與 Request ID。
 *  3. 攔截圖片上傳 FormData，於瀏覽器端自動壓縮大圖並轉為 Base64 傳送至 Google Drive。
 *  4. 自動修正 GitHub Pages 子目錄下的預設圖片相對路徑 (/static/... → static/...)。
 *  5. 自動捕捉前端未處理的錯誤並回報至後端 SystemLogs，方便店家 Debug。
 * ============================================================
 */
(function () {
  var TOKEN_KEY = "eready_admin_token";
  var CUSTOM_GAS_URL_KEY = "eready_custom_gas_url";
  var CLIENT_ERROR_BUFFER_KEY = "eready_client_error_logs";

  function getGasUrl() {
    var fromCfg = (window.EREADY_CONFIG && window.EREADY_CONFIG.GAS_WEB_APP_URL || "").trim();
    var fromLocal = (localStorage.getItem(CUSTOM_GAS_URL_KEY) || "").trim();
    return fromCfg || fromLocal;
  }

  function isGitHubPages() {
    return /\.github\.io$/i.test(window.location.hostname);
  }

  /** 將絕對路徑 /static/... 轉為相對路徑 static/...，確保在 GitHub Pages 子路徑下正常顯示 */
  function fixAssetUrl(u) {
    if (!u || typeof u !== "string") return u;
    if (u.indexOf("/static/") === 0) return u.substring(1);
    return u;
  }

  window.fixAssetUrl = fixAssetUrl;
  window.EREADY_BRIDGE = {
    getGasUrl: getGasUrl,
    setCustomGasUrl: function (url) {
      if (url) localStorage.setItem(CUSTOM_GAS_URL_KEY, url.trim());
      else localStorage.removeItem(CUSTOM_GAS_URL_KEY);
    },
    isGitHubPages: isGitHubPages,
    getLocalErrorLogs: function () {
      try { return JSON.parse(localStorage.getItem(CLIENT_ERROR_BUFFER_KEY) || "[]"); } catch (e) { return []; }
    },
    clearLocalErrorLogs: function () {
      localStorage.removeItem(CLIENT_ERROR_BUFFER_KEY);
    }
  };

  function recordLocalClientError(type, message, detail) {
    try {
      var list = window.EREADY_BRIDGE.getLocalErrorLogs();
      list.unshift({
        time: new Date().toLocaleString("zh-TW", { hour12: false }),
        type: type,
        message: message,
        detail: detail || "",
        page: window.location.pathname
      });
      localStorage.setItem(CLIENT_ERROR_BUFFER_KEY, JSON.stringify(list.slice(0, 50)));
    } catch (e) {}
  }

  /** 將圖片檔案轉為 Base64 (若為大尺寸照片則自動縮放至最大邊 1600px 以加速上傳並節省雲端硬碟空間) */
  function fileToBase64Payload(file) {
    return new Promise(function (resolve, reject) {
      var originalSize = file.size || 0;
      var mime = (file.type || "image/jpeg").toLowerCase();

      // SVG 或 GIF 或小於 400KB 的圖片直接轉 Base64 不壓縮
      if (mime === "image/svg+xml" || mime === "image/gif" || originalSize < 400 * 1024) {
        var reader = new FileReader();
        reader.onload = function () {
          var res = String(reader.result || "");
          var b64 = res.indexOf(",") >= 0 ? res.split(",")[1] : res;
          resolve({
            filename: file.name || "upload.jpg",
            mime_type: mime,
            size: originalSize,
            original_size: originalSize,
            data_base64: b64
          });
        };
        reader.onerror = function () { reject(new Error("讀取圖片失敗")); };
        reader.readAsDataURL(file);
        return;
      }

      // 較大照片透過 Canvas 溫和壓縮
      var img = new Image();
      var objUrl = URL.createObjectURL(file);
      img.onload = function () {
        URL.revokeObjectURL(objUrl);
        var maxDim = 1600;
        var w = img.width, h = img.height;
        if (w > maxDim || h > maxDim) {
          if (w >= h) { h = Math.round((h * maxDim) / w); w = maxDim; }
          else { w = Math.round((w * maxDim) / h); h = maxDim; }
        }
        var canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        var ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, w, h);
        var outMime = mime === "image/png" ? "image/png" : "image/jpeg";
        var dataUrl = canvas.toDataURL(outMime, 0.86);
        var b64 = dataUrl.split(",")[1];
        resolve({
          filename: file.name || "upload.jpg",
          mime_type: outMime,
          size: Math.round((b64.length * 3) / 4),
          original_size: originalSize,
          data_base64: b64
        });
      };
      img.onerror = function () {
        URL.revokeObjectURL(objUrl);
        reject(new Error("載入圖片失敗"));
      };
      img.src = objUrl;
    });
  }

  /** 遞迴修正後端回傳資料中的 /static/ 圖片路徑 */
  function normalizeStaticPathsInObject(obj) {
    if (!obj || typeof obj !== "object") return obj;
    for (var k in obj) {
      if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
      var v = obj[k];
      if (typeof v === "string" && v.indexOf("/static/") === 0) {
        obj[k] = v.substring(1);
      } else if (typeof v === "object" && v !== null) {
        normalizeStaticPathsInObject(v);
      }
    }
    return obj;
  }

  var nativeFetch = window.fetch.bind(window);

  window.fetch = async function (input, init) {
    init = init || {};
    var urlStr = typeof input === "string" ? input : (input && input.url) || "";

    // 只攔截本系統的 /api/... 請求
    if (urlStr.indexOf("/api/") !== 0 && urlStr.indexOf("api/") !== 0) {
      return nativeFetch(input, init);
    }

    var gasUrl = getGasUrl();

    // 若尚未設定 GAS_WEB_APP_URL：
    // - 在本機 Flask (localhost / 127.0.0.1) 直接走原生 fetch 呼叫 Flask 後端
    // - 在 GitHub Pages 上則回傳友善提示
    if (!gasUrl) {
      if (!isGitHubPages()) {
        var localRes = await nativeFetch(input, init);
        return localRes;
      }
      recordLocalClientError("CONFIG_MISSING", "尚未在 config.js 設定 GAS_WEB_APP_URL", urlStr);
      var mockBody = JSON.stringify({
        ok: false,
        error: "尚未連結 Google Apps Script 後端網址！請在 config.js 填入 GAS_WEB_APP_URL，或於後台頂部設定列貼上網址。"
      });
      return new Response(mockBody, { status: 503, headers: { "Content-Type": "application/json" } });
    }

    // 解析路徑與 Query 參數
    var qIndex = urlStr.indexOf("?");
    var path = qIndex >= 0 ? urlStr.substring(0, qIndex) : urlStr;
    if (path.charAt(0) !== "/") path = "/" + path;
    var queryObj = {};
    if (qIndex >= 0) {
      var sp = new URLSearchParams(urlStr.substring(qIndex + 1));
      sp.forEach(function (val, key) { queryObj[key] = val; });
    }

    var method = String(init.method || "GET").toUpperCase();
    var bodyObj = {};

    if (init.body) {
      if (typeof FormData !== "undefined" && init.body instanceof FormData) {
        var file = init.body.get("file");
        var prefix = init.body.get("prefix") || "img";
        if (file) {
          bodyObj.file = await fileToBase64Payload(file);
        }
        bodyObj.prefix = prefix;
      } else if (typeof init.body === "string") {
        try { bodyObj = JSON.parse(init.body); } catch (e) { bodyObj = { raw: init.body }; }
      } else if (typeof init.body === "object") {
        bodyObj = init.body;
      }
    }

    var reqId = "req_" + Date.now().toString(36) + "_" + Math.random().toString(36).substring(2, 6);
    var envelope = {
      path: path,
      method: method,
      query: queryObj,
      body: bodyObj,
      token: localStorage.getItem(TOKEN_KEY) || "",
      request_id: reqId,
      client: {
        ua: navigator.userAgent.substring(0, 160),
        page: window.location.pathname
      }
    };

    try {
      var resp = await nativeFetch(gasUrl, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify(envelope),
        redirect: "follow"
      });

      var text = await resp.text();
      var data;
      try {
        data = JSON.parse(text);
      } catch (parseErr) {
        recordLocalClientError("GAS_RESPONSE_PARSE_ERROR", "Google Apps Script 回傳非 JSON 內容 (請確認部署權限已設為「所有人」)", text.substring(0, 300));
        return new Response(JSON.stringify({
          ok: false,
          error: "後端回應格式異常，請確認 Google Apps Script 部署時「誰可以存取」已設為「所有人 (Anyone)」。"
        }), { status: 502, headers: { "Content-Type": "application/json" } });
      }

      // 自動管理登入 Token
      if (path === "/api/admin/login" && data && data.ok && data.token) {
        localStorage.setItem(TOKEN_KEY, data.token);
      } else if (path === "/api/admin/logout") {
        localStorage.removeItem(TOKEN_KEY);
      } else if (data && data.unauthorized) {
        localStorage.removeItem(TOKEN_KEY);
      }

      normalizeStaticPathsInObject(data);

      var httpStatus = (data && data._status) ? Number(data._status) : (data && data.ok === false ? 400 : 200);
      return new Response(JSON.stringify(data), {
        status: httpStatus,
        headers: { "Content-Type": "application/json" }
      });
    } catch (netErr) {
      recordLocalClientError("NETWORK_ERROR", method + " " + path + " 連線失敗：" + netErr.message, gasUrl);
      return new Response(JSON.stringify({
        ok: false,
        error: "無法連線至 Google Apps Script 伺服器，請檢查網路連線或確認 GAS 網址是否正確。"
      }), { status: 503, headers: { "Content-Type": "application/json" } });
    }
  };

  // 全域錯誤監聽：當前台發生未預期的 JS 錯誤時自動記錄並嘗試回報後端
  window.addEventListener("error", function (ev) {
    var msg = (ev && ev.message) || "前端腳本錯誤";
    var detail = ((ev && ev.filename) || "") + ":" + ((ev && ev.lineno) || "");
    recordLocalClientError("JS_ERROR", msg, detail);
    if (getGasUrl()) {
      nativeFetch(getGasUrl(), {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify({
          path: "/api/public/client-log",
          method: "POST",
          body: { type: "JS_ERROR", message: msg, detail: detail, page: window.location.pathname }
        })
      }).catch(function () {});
    }
  });
})();
