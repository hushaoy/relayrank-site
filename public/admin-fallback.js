/* 兜底登录：只有 admin.js 未成功初始化时才接管，避免正常页面被重复绑定。 */
(function () {
  var form = document.getElementById("login-form");
  if (!form) return;

  document.addEventListener("DOMContentLoaded", function () {
    if (window.__adminReady) return;
    if (document.body.dataset.authed === "1") {
      window.location.replace("/admin?plain=1");
      return;
    }

    var hint = document.getElementById("boot-hint");
    if (hint) {
      hint.hidden = false;
      hint.textContent =
        "主脚本未就绪，已启用兜底登录。" +
        (window.__bootErrors && window.__bootErrors.length ? "（" + window.__bootErrors[0] + "）" : "");
    }

    form.addEventListener("submit", function (event) {
      event.preventDefault();
      var btn = document.getElementById("login-submit");
      var err = document.getElementById("login-error");
      if (btn) btn.disabled = true;
      var xhr = new XMLHttpRequest();
      xhr.open("POST", "/api/admin/login", true);
      xhr.setRequestHeader("Content-Type", "application/json");
      xhr.onreadystatechange = function () {
        if (xhr.readyState !== 4) return;
        if (btn) btn.disabled = false;
        if (xhr.status === 200) {
          window.location.replace("/admin");
          return;
        }
        var msg = "登录失败（HTTP " + xhr.status + "）";
        try {
          msg = JSON.parse(xhr.responseText).error || msg;
        } catch (e) {
          /* 保留默认错误 */
        }
        if (err) {
          err.textContent = msg;
          err.hidden = false;
        }
      };
      xhr.send(
        JSON.stringify({
          username: document.getElementById("login-user").value,
          password: document.getElementById("login-pass").value
        })
      );
    });
  });
})();
