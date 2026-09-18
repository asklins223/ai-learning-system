/**
 * Chromium matches `:focus-visible` on every text field, including when the
 * field was focused by a mouse click — the spec keeps the ring on inputs that
 * accept keyboard typing. The global rule in styles.css therefore painted a
 * 3px focus ring on the search fields on every click, which reads as an extra
 * border appearing out of nowhere.
 *
 * The fix is the standard modality split: publish which input device was used
 * last on the document element, and let the stylesheet narrow the ring to
 * keyboard users only.
 */

export const INPUT_MODALITY_ATTRIBUTE = "inputModality";

export type InputModality = "pointer" | "keyboard";

const MODIFIER_KEYS = new Set(["Shift", "Control", "Alt", "Meta", "CapsLock"]);

/** Keys that are navigation even while a text field has focus. */
const LEAVES_TEXT_ENTRY = new Set(["Tab", "Escape"]);

const TEXT_ENTRY_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);

const isTextEntry = (target: EventTarget | null): boolean => {
  if (!(target instanceof HTMLElement)) return false;
  return TEXT_ENTRY_TAGS.has(target.tagName) || target.isContentEditable;
};

/** Mark the document for one input device and stop doing so on cleanup. */
export function trackInputModality(root: HTMLElement = document.documentElement): () => void {
  const mark = (modality: InputModality) => {
    root.dataset[INPUT_MODALITY_ATTRIBUTE] = modality;
  };

  // Pointer events cover mouse, pen and touch alike; `pointerdown` fires
  // before the focus that follows a click, so the attribute is already set
  // when the stylesheet evaluates the newly focused element.
  const onPointerDown = () => mark("pointer");
  const onKeyDown = (event: KeyboardEvent) => {
    if (MODIFIER_KEYS.has(event.key)) return;
    // Typing into a field the pointer already focused is not keyboard
    // navigation. Without this, the first character typed after clicking the
    // search field flipped the modality back and painted the ring the split
    // exists to keep off it. Tab and Escape still count — they leave the field.
    if (isTextEntry(event.target) && !LEAVES_TEXT_ENTRY.has(event.key)) return;
    mark("keyboard");
  };

  window.addEventListener("pointerdown", onPointerDown, { capture: true, passive: true });
  window.addEventListener("keydown", onKeyDown, { capture: true });

  return () => {
    window.removeEventListener("pointerdown", onPointerDown, { capture: true });
    window.removeEventListener("keydown", onKeyDown, { capture: true });
    delete root.dataset[INPUT_MODALITY_ATTRIBUTE];
  };
}
