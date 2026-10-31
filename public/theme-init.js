/* 首帧定主题：必须在 styles.css 之前以同步方式加载。
   为什么不用内联 <script>：站点 CSP 是 `script-src 'self'`，内联脚本会被浏览器直接拒绝执行，
   所以主题脚本必须走外链文件。放在 <link rel="stylesheet"> 之前，保证首帧就是正确配色。 */
(function () {
  var root = document.documentElement;
  var saved = null;
  try {
    saved = localStorage.getItem("relayrank-theme");
  } catch (e) {
    saved = null;
  }
  if (saved === "dark") {
    root.setAttribute("data-theme", "dark");
    root.removeAttribute("data-theme-light");
  } else {
    root.setAttribute("data-theme", "light");
  }
})();
