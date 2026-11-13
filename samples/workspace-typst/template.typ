// Shared by every chapter; reachable only when Typst's --root is the
// workspace folder, not the chapter's own folder (Track W2).
#let greet(name) = [Greeting from the template, #name.]
