package translit

import "testing"

func TestASCII(t *testing.T) {
	cases := []struct{ name, in, want string }{
		{"plain text is unchanged", "Hello, world!", "Hello, world!"},
		{"romanian comma-below letters", "Știință și țară", "Stiinta si tara"},
		{"romanian cedilla letters", "Şi ţie", "Si tie"},
		{"romanian vowels", "Înțeleg că mâine plouă", "Inteleg ca maine ploua"},
		{"other latin accents", "café naïve Zürich", "cafe naive Zurich"},
		{"typographic punctuation", "“Da” – a zis… ‘nu’", "\"Da\" - a zis... 'nu'"},
		{"emoji are dropped", "Bravo 👍🏽 super", "Bravo super"},
		{"only emoji gives empty text", "😀😀", ""},
		{"letters without decomposition", "Straße Łódź øre", "Strasse Lodz ore"},
		{"line breaks are kept", "unu\ndoi", "unu\ndoi"},
		{"runs of spaces collapse", "a   b \t c", "a b c"},
		{"euro sign", "10 €", "10 EUR"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := ASCII(c.in); got != c.want {
				t.Errorf("ASCII(%q) = %q, want %q", c.in, got, c.want)
			}
		})
	}
}
