// Package translit turns message text into plain ASCII.
//
// The G2 firmware font silently drops glyphs it does not have, so everything
// sent to the glasses is reduced to ASCII first: accents are removed,
// typographic punctuation is replaced and emoji are dropped.
package translit

import (
	"strings"
	"unicode"

	"golang.org/x/text/unicode/norm"
)

// replacements covers characters that Unicode decomposition does not reduce
// to an ASCII base letter.
var replacements = map[rune]string{
	'ß': "ss", 'Ł': "L", 'ł': "l", 'ø': "o", 'Ø': "O", 'đ': "d", 'Đ': "D",
	'æ': "ae", 'Æ': "AE", 'œ': "oe", 'Œ': "OE", 'þ': "th", 'Þ': "Th",
	'“': `"`, '”': `"`, '„': `"`, '«': `"`, '»': `"`,
	'‘': "'", '’': "'", '‚': "'", '`': "'",
	'–': "-", '—': "-", '−': "-", '…': "...", '•': "*", '·': ".",
	'€': "EUR", '£': "GBP", '°': " deg",
	' ': " ", ' ': " ", ' ': " ", '\t': " ",
}

// ASCII returns s reduced to printable ASCII and line breaks. Runs of spaces
// collapse to one and each line is trimmed.
func ASCII(s string) string {
	var b strings.Builder
	b.Grow(len(s))
	for _, r := range norm.NFD.String(s) {
		switch {
		case r == '\n':
			b.WriteRune(r)
		case r >= 0x20 && r < 0x7f && r != '`':
			b.WriteRune(r)
		case unicode.Is(unicode.Mn, r):
			// Combining mark left behind by the decomposition of an accented letter.
		default:
			b.WriteString(replacements[r])
		}
	}
	lines := strings.Split(b.String(), "\n")
	for i, line := range lines {
		lines[i] = strings.Join(strings.Fields(line), " ")
	}
	return strings.TrimSpace(strings.Join(lines, "\n"))
}
