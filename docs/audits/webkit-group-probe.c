/* Standalone WebKitGTK capability probe; not an application benchmark. */
#include <gtk/gtk.h>
#include <webkit2/webkit2.h>

static void evaluated(GObject *view, GAsyncResult *result, gpointer data) {
  GError *error = NULL;
  JSCValue *value = webkit_web_view_evaluate_javascript_finish(WEBKIT_WEB_VIEW(view), result, &error);
  if (error) {
    g_printerr("JavaScript: %s\n", error->message);
    g_error_free(error);
  } else {
    char *json = jsc_value_to_string(value);
    g_print("%s\n", json);
    g_free(json);
    g_object_unref(value);
  }
  gtk_main_quit();
}

static void loaded(WebKitWebView *view, WebKitLoadEvent event, gpointer data) {
  if (event != WEBKIT_LOAD_FINISHED) return;
  const char *script =
    "(()=>{const supports=CSS.supports('content-visibility','auto');"
    "const host=document.querySelector('main'),f=document.createDocumentFragment();"
    "let n=0;for(let g=0;g<1125;g++){let d=document.createElement('div');"
    "d.style='content-visibility:auto;contain-intrinsic-size:auto 3072px';"
    "for(let i=0;i<64;i++){let p=document.createElement('p');p.textContent=++n===36001?'uniqueprobetarget':'alpha bravo charlie';d.append(p)}f.append(d)}"
    "let start=performance.now();host.append(f);host.getBoundingClientRect();"
    "let elapsed=performance.now()-start,p=[...host.querySelectorAll('p')][36000];"
    "p.scrollIntoView({block:'center'});let r=p.getBoundingClientRect();"
    "let visible=r.bottom>0&&r.top<innerHeight,found=window.find('uniqueprobetarget',false,false,true);"
    "return JSON.stringify({supports,blocks:n,layoutMs:elapsed,visible,found});})()";
  webkit_web_view_evaluate_javascript(view, script, -1, NULL, NULL, NULL, evaluated, NULL);
}

int main(int argc, char **argv) {
  gtk_init(&argc, &argv);
  GtkWidget *window = gtk_window_new(GTK_WINDOW_TOPLEVEL);
  GtkWidget *view = webkit_web_view_new();
  gtk_container_add(GTK_CONTAINER(window), view);
  gtk_window_set_default_size(GTK_WINDOW(window), 900, 700);
  g_signal_connect(view, "load-changed", G_CALLBACK(loaded), NULL);
  gtk_widget_show_all(window);
  webkit_web_view_load_html(WEBKIT_WEB_VIEW(view), "<html><body><main></main></body></html>", NULL);
  gtk_main();
  gtk_widget_destroy(window);
  return 0;
}
