// Original OpenCode TTY logo (for reference / interpolation):
//   left:  
//["                   ", 
// "█▀▀█ █▀▀█ █▀▀█ █▀▀▄", 
// "█__█ █__█ █^^^ █__█", 
// "▀▀▀▀ █▀▀▀ ▀▀▀▀ ▀~~▀"]
//   right: 
//["             ▄     ", 
// "█▀▀▀ █▀▀█ █▀▀█ █▀▀█", 
// "█___ █__█ █__█ █^^^", 
// "▀▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀"]
// (spells OPEN | CODE, split 4+4, with cursor mark on top of right side)
//
// Substitution codes (see ui.ts draw()):
//   _  -> colored bg space (letter interior)
//   ^  -> fg+bg half-block ▀ (crossbars: E, B, S)
//   ~  -> shadow half-block ▀ (rounded curves: N, D)
//   █ ▀ ▄ and anything else -> fg-colored pass-through
// Rebranded to KORACODE (left = "kora", right = "code"). The `k` and `a` glyphs
// were designed to match this font's style (browsercode's source had neither).
export const logo = {
  left: [
    "▄                  ",
    "█ ▄▀ █▀▀█ █▀▀▄ █▀▀█",
    "█▀▄  █__█ █___ █^^█",
    "▀  ▀ ▀▀▀▀ ▀~~~ ▀  ▀",
  ],
  right: [
    "             ▄     ",
    "█▀▀▀ █▀▀█ █▀▀█ █▀▀█",
    "█___ █__█ █__█ █^^^",
    "▀▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀",
  ],
}

export const go = {
  left: [
    "    ",
    "█▀▀▀", 
    "█_^█", 
    "▀▀▀▀"],
  right: [
    "    ", 
    "█▀▀█", 
    "█__█", 
    "▀▀▀▀"],
}

export const marks = "_^~,"
