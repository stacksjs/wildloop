/**
 * The author of a Commons file, as a credit line a person would write.
 *
 * Commons hands the author over as `extmetadata.Artist`, which is whatever
 * HTML the uploader's template or signature rendered. For a Flickr import
 * that is a link and a name; for a Wikipedian it is often their signature,
 * and a signature carries links to their talk page and contributions:
 *
 *   Phil Mieszkowski (talk · contribs)
 *   Walter Siegmund (talk)
 *   Nard.tech ‧ talk | contributions| uploads
 *
 * Those links are how to reach a wiki user, not part of who took the photo,
 * and "By Phil Mieszkowski (talk · contribs)" under a trail cover reads as a
 * rendering bug. So a link to a talk page, a contributions list or an uploads
 * list goes when its text is one of those labels (or a symbol standing in for
 * one), and so does the same thing written out as plain text. A link whose
 * text is somebody's name stays, wherever it points: some signatures put the
 * name itself on the talk-page link.
 *
 * Also dropped: text hidden with `display: none` (Commons' "Unknown author"
 * template renders its words twice, once hidden), the template boxes that
 * follow a name (a `<div>` saying the image was stitched with Hugin), a
 * signature's timestamp, the "User:" of a red link, and the source file's
 * name at the head of a derivative-work list — the list itself stays, one
 * author after another, because a derivative's credit is everyone on it.
 */

/** What a talk, contributions or uploads link says instead of a name. */
const PROFILE_LABEL = /^(?:talk|t|contribs?|contributions?|c|uploads?|e-?mail|diskussion|disk|beitr[aä]ge|discussion|discuter|contributions)$/i

/** Where those links go, read from the link's title or its decoded href. */
const PROFILE_PAGE = /(?:^|[:/])(?:User[_ ]talk|Benutzer[_ ]Diskussion|Benutzerin[_ ]Diskussion|Discussion[_ ]utilisateur|Special:(?:Contributions|ListFiles|EmailUser|Log)|Spezial:(?:Beitr[aä]ge|Dateien|E-Mail[_ ]senden))(?:[:/]|$)/i

/** A link to a file page: the source of a derivative work, not an author. */
const FILE_PAGE = /(?:^|[:/])(?:File|Datei|Fichier|Image):/i

/** The same labels written as plain text, in brackets: "(talk | contribs)". */
const LABEL_WORD = String.raw`(?:talk|contribs?|contributions?|uploads?|e-?mail)`
const LABELS_IN_BRACKETS = new RegExp(String.raw`\(\s*${LABEL_WORD}(?:\s*[·•‧|/,]?\s*${LABEL_WORD})*\s*\)`, 'gi')
const LABELS_AFTER_NAME = new RegExp(String.raw`\s+${LABEL_WORD}(?:\s*[·•‧|/]\s*${LABEL_WORD})+(?=\s*(?:[;,)]|$))`, 'gi')

/** A wiki signature's timestamp: "05:21, 7 June 2009 (UTC)". */
const SIGNATURE_TIME = /\b\d{1,2}:\d{2},\s+\d{1,2}\s+\p{L}+\s+\d{4}\s*\(UTC\)/gu

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'', nbsp: ' ', middot: '·', bull: '•', ndash: '–', mdash: '—' }

function decodeEntities(text: string): string {
  // eslint-disable-next-line pickier/no-unused-vars -- replace() passes the whole match first
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] === '#') {
      const point = code[1] === 'x' || code[1] === 'X' ? Number.parseInt(code.slice(2), 16) : Number(code.slice(1))
      return Number.isFinite(point) && point > 0 && point <= 0x10FFFF ? String.fromCodePoint(point) : ' '
    }
    return ENTITIES[code.toLowerCase()] ?? ' '
  })
}

function attribute(attributes: string, name: string): string {
  const match = new RegExp(String.raw`\b${name}\s*=\s*("([^"]*)"|'([^']*)')`, 'i').exec(attributes)
  const value = decodeEntities(match?.[2] ?? match?.[3] ?? '')
  try {
    return decodeURIComponent(value)
  }
  catch {
    return value
  }
}

const tagless = (html: string): string => decodeEntities(html.replace(/<[^>]*>/g, '')).trim()

/** A talk or contributions link whose text is a label, or no word at all ("↑↓", "©"). */
function isProfileLink(attributes: string, inner: string): boolean {
  const target = `${attribute(attributes, 'title')} ${attribute(attributes, 'href')}`
  if (!PROFILE_PAGE.test(target))
    return false
  const text = tagless(inner).replace(/^[([]+|[)\]]+$/g, '').trim()
  return PROFILE_LABEL.test(text) || !/[\p{L}\p{N}]/u.test(text)
}

/** The credit line for a Commons `Artist` value: a name, or names, in plain text. */
export function creditText(artist: unknown): string {
  let html = String(artist ?? '')

  // Hidden text, and everything inside it.
  html = html.replace(/<(span|div)\b[^>]*display\s*:\s*none[^>]*>[\s\S]*?<\/\1>/gi, ' ')
  // A template box after the name. Kept only when it is all there is.
  const box = html.search(/<(?:div|table)\b/i)
  if (box > 0 && tagless(html.slice(0, box)))
    html = html.slice(0, box)

  html = html.replace(/<a\b([^>]*)>([\s\S]*?)<\/a>(\s*:)?/gi, (whole, attributes: string, inner: string) => {
    if (isProfileLink(attributes, inner))
      return ' '
    // "Source.jpg: Alan Levine" in a derivative-work list.
    if (FILE_PAGE.test(attribute(attributes, 'title')))
      return ' '
    return whole
  })

  // One author per list item or paragraph. Other block tags are a space;
  // inline ones are nothing, so a signature styled letter by letter stays
  // one word.
  html = html
    .replace(/<\/(?:li|p)>|<br\s*\/?>/gi, '; ')
    .replace(/<\/?(?:ul|ol|li|p|div|table|tr|td|th|dl|dt|dd|pre|h\d)\b[^>]*>/gi, ' ')

  return decodeEntities(html.replace(/<[^>]*>/g, ''))
    .replace(SIGNATURE_TIME, ' ')
    .replace(LABELS_IN_BRACKETS, ' ')
    .replace(LABELS_AFTER_NAME, ' ')
    // A red link to someone with no user page reads "User:Name".
    .replace(/(^|[\s(;,:])(?:User|Benutzer|Utilisateur):(?=\S)/g, '$1')
    .replace(/\s+/g, ' ')
    // Separators left orphaned by what went: "Nard.tech ‧ ", "( · )".
    .replace(/\s*[·•‧|]\s*(?=[);]|$)/g, '')
    .replace(/\(\s*[·•‧|,;:/-]*\s*\)/g, ' ')
    .replace(/\(\s+/g, '(')
    .replace(/\s+([,.;:)])/g, '$1')
    .replace(/(?:;\s*)+/g, '; ')
    .replace(/^[\s·•‧|,;:—–-]+|[\s·•‧|,;:—–.-]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}
