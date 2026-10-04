import { describe, expect, it } from 'bun:test'
import { creditText } from '../../app/Support/commonsCredit'

/**
 * The credit under a trail cover, from Commons' `Artist` field (#1006).
 *
 * Every input below is a real `extmetadata.Artist` value, copied from the
 * Commons API (2026-10-04) for files around Sedona, Yosemite, the Grand
 * Canyon, the Zugspitze and the Jungfrau, and for files whose authors sign
 * with talk and contributions links. Uploaders' signatures are how
 * "Phil Mieszkowski (talk · contribs)" ended up under a photograph.
 */

describe('creditText', () => {
  describe('drops the links for reaching a wiki user', () => {
    it.each([
      [
        'talk · contribs, on English Wikipedia',
        '<a href="https://en.wikipedia.org/wiki/User:Philm555" class="extiw" title="en:User:Philm555">Phil Mieszkowski</a> (<a href="https://en.wikipedia.org/wiki/User_talk:Philm555" class="extiw" title="en:User talk:Philm555">talk</a><span style="white-space:nowrap"> <span style="font-weight:bold;">·</span></span> <a href="https://en.wikipedia.org/wiki/Special:Contributions/Philm555" class="extiw" title="en:Special:Contributions/Philm555">contribs</a>)',
        'Phil Mieszkowski',
      ],
      [
        '(talk) inside the link',
        '<a href="//commons.wikimedia.org/wiki/User:Wsiegmund" title="User:Wsiegmund">Walter Siegmund</a> <a href="//commons.wikimedia.org/wiki/User_talk:Wsiegmund" title="User talk:Wsiegmund">(talk)</a>',
        'Walter Siegmund',
      ],
      [
        '(talk) alone',
        '<a href="https://en.wikipedia.org/wiki/User:Chris_Light" class="extiw" title="en:User:Chris Light">Chris Light</a> (<a href="https://en.wikipedia.org/wiki/User_talk:Chris_Light" class="extiw" title="en:User talk:Chris Light">talk</a>)',
        'Chris Light',
      ],
      [
        'talk • contribs in small type, and a full stop',
        '<b><i><a href="https://en.wikipedia.org/wiki/User:PageantUpdater" class="extiw" title="en:User:PageantUpdater">PageantUpdater</a><small>  <a href="https://en.wikipedia.org/wiki/User_talk:PageantUpdater" class="extiw" title="en:User talk:PageantUpdater">talk</a> • <a href="https://en.wikipedia.org/wiki/Special:Contributions/PageantUpdater" class="extiw" title="en:Special:Contributions/PageantUpdater">contribs</a> </small></i></b>.',
        'PageantUpdater',
      ],
      [
        'talk | contributions | uploads, after a red link',
        '<a href="//commons.wikimedia.org/w/index.php?title=User:Nard.tech&amp;action=edit&amp;redlink=1" class="new" title="User:Nard.tech (page does not exist)">Nard.tech</a> ‧ <sup><a href="//commons.wikimedia.org/wiki/User_talk:Nard.tech" title="User talk:Nard.tech">talk</a> | <a href="//commons.wikimedia.org/wiki/Special:Contributions/Nard.tech" title="Special:Contributions/Nard.tech">contributions</a>| <a href="//commons.wikimedia.org/wiki/Special:ListFiles/Nard.tech" title="Special:ListFiles/Nard.tech">uploads</a></sup>',
        'Nard.tech',
      ],
      [
        'Talk and Contribs run together, in superscript',
        '<span style="color: #B3B0AC;background-color: #080806;">Surv1v4l1st</span> <sup><span style="font-size:8px">(<a href="https://en.wikipedia.org/wiki/User_talk:Surv1v4l1st" class="extiw" title="w:User talk:Surv1v4l1st">Talk</a><a href="https://en.wikipedia.org/wiki/Special:Contributions/Surv1v4l1st" class="extiw" title="w:Special:Contributions/Surv1v4l1st">Contribs</a>)</span></sup>',
        'Surv1v4l1st',
      ],
      [
        'a whole signature, timestamp and all',
        '<a href="https://en.wikipedia.org/wiki/User:Shannon1" class="extiw" title="en:User:Shannon1"><span style="font-family: Mistral; color: #008080; font-size: x-large;">Shannon1</span></a><a href="https://en.wikipedia.org/wiki/User_talk:Shannon1" class="extiw" title="en:User talk:Shannon1"><span style="color:#E9967A"><sup><b>talk</b></sup></span></a> <a href="https://en.wikipedia.org/wiki/Special:Contributions/Shannon1" class="extiw" title="en:Special:Contributions/Shannon1"><span style="color:#E9967A"><sup><b>contribs</b></sup></span></a> 05:21, 7 June 2009 (UTC)',
        'Shannon1',
      ],
      [
        'arrows and a copyright sign standing in for talk and contribs',
        '<a href="//commons.wikimedia.org/wiki/User:Alfie66" title="User:Alfie66"><span style="font:600 small-caps Verdana; color:#fff;background-color:#955; padding:0 3px;">Alfie</span></a><a href="//commons.wikimedia.org/wiki/User_talk:Alfie66" title="User talk:Alfie66"><span style="color:#fff;background-color:#559; padding:0 3px;">↑↓</span></a><a href="//commons.wikimedia.org/wiki/Special:Contributions/Alfie66" title="Special:Contributions/Alfie66">©</a> (Helmut Schütz)',
        'Alfie (Helmut Schütz)',
      ],
    ])('%s', (_case, artist, credit) => {
      expect(creditText(artist)).toBe(credit)
    })

    it('drops them written out as plain text too', () => {
      const artist = '<ul><li><a href="//commons.wikimedia.org/wiki/File:Ferozesons_Building_-_The_Mall.jpeg" title="File:Ferozesons Building - The Mall.jpeg">Ferozesons_Building_-_The_Mall.jpeg</a>: <b><a href="//commons.wikimedia.org/w/index.php?title=Fast_track&amp;action=edit&amp;redlink=1" class="new" title="Fast track (page does not exist)">Fast track</a>  (talk | contribs)</b></li>\n<li>derivative work: <a href="//commons.wikimedia.org/wiki/User:Watercolor121" title="User:Watercolor121">Watercolor121</a> (<a href="//commons.wikimedia.org/wiki/User_talk:Watercolor121" title="User talk:Watercolor121"><span class="signature-talk">talk</span></a>)</li></ul>'
      expect(creditText(artist)).toBe('Fast track; derivative work: Watercolor121')
      expect(creditText('Phil Mieszkowski ( talk · contribs )')).toBe('Phil Mieszkowski')
      expect(creditText('Phil Mieszkowski talk · contribs')).toBe('Phil Mieszkowski')
    })

    /*
     * Some signatures put the name itself on the talk-page link. That link is
     * the author, whatever it points at.
     */
    it('keeps a name that links to a talk page', () => {
      expect(creditText('<a href="https://en.wikipedia.org/wiki/User_talk:Wsiegmund" class="extiw" title="en:User talk:Wsiegmund">Walter Siegmund</a>'))
        .toBe('Walter Siegmund')
      expect(creditText('<a href="//commons.wikimedia.org/wiki/Special:Contributions/Wdcf" title="Special:Contributions/Wdcf">Wdcf</a>'))
        .toBe('Wdcf')
    })
  })

  describe('keeps every author of a derivative work', () => {
    it('lists them, without the source file\'s name', () => {
      const artist = '<ul><li><a href="//commons.wikimedia.org/wiki/File:Wide_View_of_Sedona_Red_Rock_Country.jpg" title="File:Wide View of Sedona Red Rock Country.jpg">Wide_View_of_Sedona_Red_Rock_Country.jpg</a>: Alan Levine</li>\n<li>derivative work: <a href="//commons.wikimedia.org/wiki/User:LtPowers" title="User:LtPowers">LtPowers</a></li></ul>'
      expect(creditText(artist)).toBe('Alan Levine; derivative work: LtPowers')
    })

    it('reads a paragraph as one author, and a red link\'s talk link as nothing', () => {
      const artist = '<p><a href="//commons.wikimedia.org/wiki/File:Reliefkarte_%C3%96sterreich.png" title="File:Reliefkarte Österreich.png">Reliefkarte Österreich.png</a>: <a href="//commons.wikimedia.org/wiki/User:Tschubby" title="User:Tschubby">Tschubby</a>\n</p>\nderivative work: Carsten Finis (<a href="//commons.wikimedia.org/w/index.php?title=User:Pyrokrat&amp;action=edit&amp;redlink=1" class="new" title="User:Pyrokrat (page does not exist)">Pyrokrat</a> <small><a href="//commons.wikimedia.org/wiki/User_talk:Pyrokrat" title="User talk:Pyrokrat"><span class="signature-talk">talk</span></a></small>)'
      expect(creditText(artist)).toBe('Tschubby; derivative work: Carsten Finis (Pyrokrat)')
    })
  })

  describe('reads the rest of what Commons sends as text', () => {
    it('says "Unknown author" once, not again from the hidden copy', () => {
      expect(creditText('Unknown author<span style="display: none;">Unknown author</span>')).toBe('Unknown author')
    })

    it('leaves out a template box after the name', () => {
      const artist = '<a href="//commons.wikimedia.org/w/index.php?title=User:Apde&amp;action=edit&amp;redlink=1" class="new" title="User:Apde (page does not exist)">apde</a> <div style="display:table;width:;vertical-align:middle;direction:ltr;float:left;line-height:22px;height:24px;font-size:.96em;margin:0px;padding:2px 4px 2px 6px;"><span>This image was created with <a href="https://en.wikipedia.org/wiki/Hugin_(software)" class="extiw" title="w:Hugin (software)">Hugin</a>.</span></div>'
      expect(creditText(artist)).toBe('apde')
    })

    it('drops "User:" from a red link to someone with no user page', () => {
      expect(creditText('<a href="//commons.wikimedia.org/w/index.php?title=User:Kissmykumbaya&amp;action=edit&amp;redlink=1" class="new" title="User:Kissmykumbaya (page does not exist)">User:Kissmykumbaya</a>'))
        .toBe('Kissmykumbaya')
      expect(creditText('<a href="//commons.wikimedia.org/wiki/User:Bautsch" title="User:Bautsch">Bautsch</a>, photocropper:<a href="//commons.wikimedia.org/wiki/User:LudwigSebastianMicheler" title="User:LudwigSebastianMicheler">User:LudwigSebastianMicheler</a>'))
        .toBe('Bautsch, photocropper:LudwigSebastianMicheler')
    })

    it('keeps a Flickr author and where they are from, as Flickr credits them', () => {
      expect(creditText('<a rel="nofollow" class="external text" href="https://www.flickr.com/people/86624586@N00">Kevin Walsh</a> from Bicester, England'))
        .toBe('Kevin Walsh from Bicester, England')
      expect(creditText('Brady Smith; <a rel="nofollow" class="external text" href="https://www.flickr.com/people/42034606@N05">Coconino National Forest</a>'))
        .toBe('Brady Smith; Coconino National Forest')
    })

    it('tidies the spaces the markup leaves around punctuation', () => {
      expect(creditText('Photograph by <a href="//commons.wikimedia.org/wiki/User:Mike_Peel" title="User:Mike Peel">Mike Peel</a> (<a rel="nofollow" class="external text" href="https://www.mikepeel.net/">www.mikepeel.net</a>).'))
        .toBe('Photograph by Mike Peel (www.mikepeel.net)')
      expect(creditText('<a href="https://en.wikipedia.org/wiki/de:User:Terabyte" class="extiw" title="w:de:User:Terabyte">Terabyte</a> at <a href="https://en.wikipedia.org/wiki/de:" class="extiw" title="w:de:">German Wikipedia</a>'))
        .toBe('Terabyte at German Wikipedia')
    })

    it('decodes entities and survives nothing at all', () => {
      expect(creditText('Smith &amp; Jones&#160;Photography')).toBe('Smith & Jones Photography')
      expect(creditText(null)).toBe('')
      expect(creditText(undefined)).toBe('')
      expect(creditText('<span></span>')).toBe('')
    })
  })
})
