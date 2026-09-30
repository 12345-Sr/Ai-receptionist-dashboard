/**
 * Converts Devanagari / Hindi names into clean English (Roman script).
 */
const commonNameMap = {
  "स्रतांशु": "Sratanshu",
  "शुक्ला": "Shukla",
  "राहुल": "Rahul",
  "वर्मा": "Verma",
  "प्रिया": "Priya",
  "सिंह": "Singh",
  "अमित": "Amit",
  "कुमार": "Kumar",
  "सुनीता": "Sunita",
  "देवी": "Devi",
  "विकास": "Vikas",
  "यादव": "Yadav",
  "रोहित": "Rohit",
  "अनन्या": "Ananya",
  "संजय": "Sanjay",
  "गुप्ता": "Gupta",
  "नायर": "Nair",
  "अमु": "Amu",
  "अमन": "Aman",
  "दीपक": "Deepak",
  "गौरव": "Gaurav",
  "मनीष": "Manish",
  "अभिषेक": "Abhishek",
  "पूजा": "Pooja",
  "नेहा": "Neha",
  "शर्मा": "Sharma",
  "मिश्रा": "Mishra",
  "पांडेय": "Pandey",
  "तिवारी": "Tiwari",
  "दुबे": "Dubey",
  "त्रिपाठी": "Tripathi",
  "चौहान": "Chauhan",
  "राठौड़": "Rathore",
  "जोशी": "Joshi",
  "पटेल": "Patel",
  "खान": "Khan",
  "अंसारी": "Ansari",
  "आकाश": "Aakash",
  "अंजलि": "Anjali",
  "सलोनी": "Saloni",
  "प्रीति": "Preeti",
  "राज": "Raj",
  "सोनू": "Sonu",
  "मोनू": "Monu"
};

const vowels = {
  "अ": "A", "आ": "Aa", "इ": "I", "ई": "Ee", "उ": "U", "ऊ": "Oo",
  "ऋ": "Ri", "ए": "E", "ऐ": "Ai", "ओ": "O", "औ": "Au", "अं": "An", "अः": "Ah"
};

const matras = {
  "ा": "a", "ि": "i", "ी": "i", "ु": "u", "ू": "u",
  "ृ": "ri", "े": "e", "ै": "ai", "ो": "o", "ौ": "au",
  "ं": "n", "ँ": "n", "ः": "h", "्": ""
};

const consonants = {
  "क": "k", "ख": "kh", "ग": "g", "घ": "gh", "ङ": "ng",
  "च": "ch", "छ": "chh", "ज": "j", "झ": "jh", "ञ": "ny",
  "ट": "t", "ठ": "th", "ड": "d", "ढ": "dh", "ण": "n",
  "त": "t", "थ": "th", "द": "d", "ध": "dh", "न": "n",
  "प": "p", "फ": "ph", "ब": "b", "भ": "bh", "म": "m",
  "य": "y", "र": "r", "ल": "l", "व": "v", "श": "sh",
  "ष": "sh", "स": "s", "ह": "h", "क़": "q", "ख़": "kh",
  "ग़": "g", "ज़": "z", "फ़": "f", "ड़": "d", "ढ़": "dh"
};

function toEnglishName(str) {
  if (!str) return "";
  const trimmed = String(str).trim();
  // If already pure English/ASCII, return as Title Case
  if (/^[A-Za-z\s.'-]+$/.test(trimmed)) {
    return trimmed
      .split(/\s+/)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
      .join(" ");
  }

  const words = trimmed.split(/\s+/);
  const res = words.map((w) => {
    if (commonNameMap[w]) return commonNameMap[w];

    let wordOut = "";
    for (let i = 0; i < w.length; i++) {
      const char = w[i];
      const next = w[i + 1];

      if (vowels[char]) {
        wordOut += vowels[char];
      } else if (consonants[char]) {
        const eng = consonants[char];
        if (!next || next === " " || consonants[next] || vowels[next]) {
          wordOut += (i === 0 ? eng.toUpperCase() : eng) + (i === w.length - 1 ? "" : "a");
        } else if (matras[next] !== undefined) {
          wordOut += (i === 0 ? eng.toUpperCase() : eng) + matras[next];
          i++; // Skip matra
        } else {
          wordOut += i === 0 ? eng.toUpperCase() : eng;
        }
      } else if (matras[char] !== undefined) {
        wordOut += matras[char];
      } else {
        wordOut += char;
      }
    }

    return wordOut ? wordOut.charAt(0).toUpperCase() + wordOut.slice(1) : w;
  });

  return res.join(" ");
}

module.exports = { toEnglishName };
