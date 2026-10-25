//! The script that makes a print document wait for its resources.
//!
//! It is shared by the Markdown/AsciiDoc print wrapper and the HTML source
//! print copy: two implementations would drift, and the one that kept the old
//! `load` handler would print before lazy figures or KaTeX fonts were ready.

export const PRINT_READY_SCRIPT = `(function(){
  var started = false;
  function warn(failed){
    if(!failed.length) return;
    var box = document.createElement('div');
    box.setAttribute('data-print-warning','');
    box.style.cssText = 'border:1px solid #cf222e;background:#fff2f0;color:#1a1a1a;' +
      'padding:8px 10px;margin:0 0 14px;font:13px/1.45 sans-serif;border-radius:4px';
    box.textContent = 'These resources did not load and may be missing from the printout: ' +
      failed.join(', ');
    document.body.insertBefore(box, document.body.firstChild);
  }
  function start(){
    if(started) return;
    started = true;
    var images = Array.prototype.slice.call(document.images);
    images.forEach(function(image){ image.loading = 'eager'; });
    var waits = images.map(function(image){
      if(image.complete) return Promise.resolve();
      return new Promise(function(resolve){
        image.addEventListener('load', resolve, { once: true });
        image.addEventListener('error', resolve, { once: true });
      });
    });
    var fonts = document.fonts && document.fonts.ready
      ? document.fonts.ready
      : Promise.resolve();
    var cap = new Promise(function(resolve){ setTimeout(resolve, 10000); });
    Promise.race([Promise.all(waits.concat([fonts])), cap]).then(function(){
      requestAnimationFrame(function(){
        requestAnimationFrame(function(){
          var failed = images
            .filter(function(image){ return !image.complete || image.naturalWidth === 0; })
            .map(function(image){ return image.getAttribute('src') || image.src; });
          warn(failed);
          window.print();
        });
      });
    });
  }
  if(document.readyState === 'complete') setTimeout(start, 0);
  else window.addEventListener('load', start);
})();`;
