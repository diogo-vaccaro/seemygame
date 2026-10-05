# MathJax SVG runtime

Local MathJax 4.1.3 and `@mathjax/mathjax-newcm-font` 4.1.3, licensed Apache-2.0. Source: https://github.com/mathjax/MathJax and https://github.com/mathjax/MathJax-fonts.

Run `npm ci` and `npm run vendor:mathjax` to reproduce these files from the locked packages. `VERSION.json` records both versions. The font package declares Apache-2.0 and omits a license file; `font/LICENSE` contains the Apache-2.0 license supplied by MathJax.

Only startup, core, TeX base/AMS, SVG output and New Computer Modern SVG glyph data are included. Accessibility workers, menus, autoload and external packages are not loaded. The app supplies accessible editable source and preview status. Dynamic SVG font data is served locally via `fontPath`.
