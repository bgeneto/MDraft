/**
 * The icons a figure's `<icon name="…"/>` can draw: plain strokes on a 24-unit
 * grid, drawn for MDraft. Unknown names draw nothing; an icon is decoration and
 * never carries a figure's meaning on its own.
 */

const ARROW_DOWN = ["M12 5v14", "M6 13l6 6 6-6"];
const ARROW_UP = ["M12 19V5", "M6 11l6-6 6 6"];
const ARROW_RIGHT = ["M5 12h14", "M13 6l6 6-6 6"];
const ARROW_LEFT = ["M19 12H5", "M11 6l-6 6 6 6"];
const CHECK = ["M5 12.5l4.5 4.5L19 7.5"];
const CLOSE = ["M6 6l12 12", "M18 6L6 18"];
const INFO = ["M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z", "M12 11v5", "M12 8h.01"];
const WARNING = ["M12 4L2.5 20h19L12 4z", "M12 10v4", "M12 17h.01"];

export const ICONS: Record<string, readonly string[]> = {
  "arrow-down": ARROW_DOWN,
  "arrow-up": ARROW_UP,
  "arrow-right": ARROW_RIGHT,
  "arrow-left": ARROW_LEFT,
  "chevron-down": ["M6 9l6 6 6-6"],
  "chevron-up": ["M6 15l6-6 6 6"],
  "chevron-right": ["M9 6l6 6-6 6"],
  "chevron-left": ["M15 6l-6 6 6 6"],
  check: CHECK,
  "check-circle": ["M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z", "M8 12.5l3 3 5-6"],
  x: CLOSE,
  close: CLOSE,
  plus: ["M12 5v14", "M5 12h14"],
  minus: ["M5 12h14"],
  info: INFO,
  "info-circle": INFO,
  warning: WARNING,
  "alert-triangle": WARNING,
  alert: WARNING,
  circle: ["M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z"],
  dot: ["M12 11a1 1 0 1 0 0 2 1 1 0 0 0 0-2z"],
  "arrow-down-right": ["M7 7l10 10", "M17 9v8H9"],
  "arrow-up-right": ["M7 17L17 7", "M9 7h8v8"],
};
