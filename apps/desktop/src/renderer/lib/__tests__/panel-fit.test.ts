import { describe, expect, it } from "vitest";
import { fitPanel } from "../panel-fit.js";

const window = { width: 1200, height: 900 };
const panel = { width: 320, height: 420 };

describe("fitPanel", () => {
  it("opens below a trigger near the top of the window", () => {
    expect(fitPanel({ top: 20, bottom: 44, left: 200 }, window, panel)).toEqual({
      placement: "below",
      align: "start",
      maxHeight: 420,
    });
  });

  it("opens above a trigger at the foot of the window", () => {
    // The composer's model pill: little room below, plenty above.
    expect(fitPanel({ top: 820, bottom: 846, left: 480 }, window, panel)).toMatchObject({
      placement: "above",
      maxHeight: 420,
    });
  });

  it("never grows taller than the room it opens into", () => {
    const fit = fitPanel({ top: 300, bottom: 326, left: 0 }, { width: 1200, height: 600 }, panel);
    expect(fit.placement).toBe("above");
    expect(fit.maxHeight).toBe(300 - 8 - 12);
  });

  it("stays below when that side has more room, even if short", () => {
    const fit = fitPanel({ top: 100, bottom: 126, left: 0 }, { width: 1200, height: 500 }, panel);
    expect(fit).toMatchObject({ placement: "below", maxHeight: 500 - 126 - 8 - 12 });
  });

  it("lines up with the trigger's right edge near the window's right side", () => {
    // The header's model pill sits at the far right.
    expect(fitPanel({ top: 20, bottom: 44, left: 1020 }, window, panel).align).toBe("end");
    expect(fitPanel({ top: 20, bottom: 44, left: 860 }, window, panel).align).toBe("start");
  });
});
