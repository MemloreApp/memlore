/**
 * The character classes memlore-core refuses in plain outbox text (outbox.rs
 * `is_plain_location_text`, `is_plain_persona_text`, and `check_name` for tag / journal /
 * template names), so a web write strips exactly what the sealer would reject and a stripped
 * text always seals.
 */

/** A Unicode Cc control character (Rust `char::is_control`): U+0000–U+001F, U+007F–U+009F. */
export const isControlCodePoint = (cp: number): boolean => cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f)

/**
 * memlore-core `is_disguising_char`: a line / paragraph separator (U+2028 / U+2029), a zero-width
 * space or directional mark (U+200B, U+200E, U+200F, U+061C, U+FEFF), a bidi embedding / override
 * / isolate (U+202A–U+202E, U+2066–U+2069) or a Unicode tag character (U+E0000–U+E007F). ZWNJ /
 * ZWJ (U+200C / U+200D) are plain text: emoji sequences, Persian and Indic words.
 */
export function isDisguisingCodePoint(cp: number): boolean {
  return (
    cp === 0x061c ||
    cp === 0xfeff ||
    cp === 0x2028 ||
    cp === 0x2029 ||
    cp === 0x200b ||
    cp === 0x200e ||
    cp === 0x200f ||
    (cp >= 0x202a && cp <= 0x202e) ||
    (cp >= 0x2066 && cp <= 0x2069) ||
    (cp >= 0xe0000 && cp <= 0xe007f)
  )
}

/** A lone surrogate code point: no Rust string can hold one. */
export const isSurrogateCodePoint = (cp: number): boolean => cp >= 0xd800 && cp <= 0xdfff
