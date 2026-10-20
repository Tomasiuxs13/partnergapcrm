// Snapshot prelude (spec 4.14). Owner G3-6. A classic script that build_snapshot.mjs puts before the bundle.
// It is not a module and is never bundled: it only prepares the page for the sandboxed artifact frame.
//   1. window.__SNAPSHOT__ from the embedded JSON ({builtAt, asOf, meta, cols, rows, programs?, activity?}),
//      and window.BUILD = meta.build (so the shell never offers "A new version is ready").
//   2. The clock runs from asOf: Today, due dates and "quiet" days are those of the day the data is from.
//   3. No popups, no print dialog, no downloads and no mailto: window.open and window.print do nothing, and
//      clicks on download, blob:, data: and mailto: links are cancelled.
//   4. Hash routing inside a frame whose URL can't be rewritten (an about:srcdoc frame): if pushState or
//      replaceState refuses, only the #hash changes; and a #link whose base URL is another document changes
//      the hash in place instead of loading that document.
(function () {
  "use strict";
  var el = document.getElementById("pg-snapshot-data");
  var snap = JSON.parse(el ? el.textContent : "{}");
  window.__SNAPSHOT__ = snap;
  window.BUILD = (snap.meta && snap.meta.build) || "snapshot";

  var RealDate = Date;
  var asOf = RealDate.parse(snap.asOf || "");
  var shift = isFinite(asOf) ? asOf - RealDate.now() : 0;
  if (Math.abs(shift) > 60000) {
    var ShiftedDate = function Date() {
      var args = Array.prototype.slice.call(arguments);
      if (!new.target) return new RealDate(RealDate.now() + shift).toString();
      if (!args.length) return new RealDate(RealDate.now() + shift);
      return new (Function.prototype.bind.apply(RealDate, [null].concat(args)))();
    };
    ShiftedDate.prototype = RealDate.prototype;
    ShiftedDate.now = function () { return RealDate.now() + shift; };
    ShiftedDate.parse = RealDate.parse;
    ShiftedDate.UTC = RealDate.UTC;
    window.Date = ShiftedDate;
  }

  window.open = function () { return null; };
  window.print = function () {};
  document.addEventListener("click", function (e) {
    var a = e.target && e.target.closest ? e.target.closest("a") : null;
    if (!a) return;
    var href = a.getAttribute("href") || "";
    if (a.hasAttribute("download") || /^\s*(mailto|blob|data):/i.test(href)) e.preventDefault();
  }, true);

  ["pushState", "replaceState"].forEach(function (name) {
    var orig = history[name];
    history[name] = function (state, title, url) {
      try {
        return orig.apply(history, arguments);
      } catch (err) {
        var s = url == null ? "" : String(url);
        var i = s.indexOf("#");
        if (i >= 0 && location.hash !== s.slice(i)) location.hash = s.slice(i);
      }
    };
  });
  window.addEventListener("click", function (e) {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    var a = e.target && e.target.closest ? e.target.closest("a[href^='#']") : null;
    if (!a || (a.target && a.target !== "_self")) return;
    if (a.href.split("#")[0] === location.href.split("#")[0]) return;
    e.preventDefault();
    location.hash = a.getAttribute("href");
  });
})();
