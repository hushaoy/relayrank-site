(function () {
  window.__bootErrors = [];
  window.addEventListener("error", function (e) {
    window.__bootErrors.push(e.message || "err");
  });
  var ok =
    typeof Promise === "function" &&
    typeof fetch === "function" &&
    typeof URLSearchParams === "function" &&
    typeof Element !== "undefined" &&
    typeof Element.prototype.closest === "function";
  if (!ok) {
    window.location.replace("/admin?plain=1");
    return;
  }
  document.addEventListener(
    "submit",
    function (e) {
      var f = e.target;
      if (f && f.id === "login-form") {
        try {
          sessionStorage.setItem("boot_pass", "1");
        } catch (x) {}
      }
    },
    true
  );
  var j = false;
  try {
    j = sessionStorage.getItem("boot_pass") === "1";
    if (j) sessionStorage.removeItem("boot_pass");
  } catch (x) {
    j = false;
  }
  if (j) return;
  var of = window.fetch;
  window.fetch = function (i, n) {
    var u = typeof i === "string" ? i : (i && i.url) || "";
    if (u.indexOf("/api/admin/session") !== -1) {
      return Promise.reject(new TypeError("blocked"));
    }
    return of.call(this, i, n);
  };
})();
