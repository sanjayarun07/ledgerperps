/** Validation is shown only after the user has typed something into the ticket; an untouched form shows just the button's guidance. */
export function sizeTouched(sizeIn: string): boolean { return sizeIn.trim() !== ""; }
/** TP/SL problems are shown only when TP/SL is on and at least one of its prices was typed (a prefilled limit price does not count). */
export function tpslTouched(withTpsl: boolean, tp: string, sl: string): boolean { return withTpsl && (tp.trim() !== "" || sl.trim() !== ""); }
