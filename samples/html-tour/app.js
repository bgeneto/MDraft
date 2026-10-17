document.body.dataset.external = "yes";
document.getElementById("external-marker").textContent = "external script ran";

fetch("data.json")
  .then(() => {
    document.getElementById("fetch-marker").textContent = "local fetch read data";
    document.body.dataset.fetch = "read";
  })
  .catch(() => {
    document.getElementById("fetch-marker").textContent = "local fetch blocked";
    document.body.dataset.fetch = "blocked";
  });
