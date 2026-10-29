// Tablet (kiosk) helpers: wording in Hebrew and English, input checks, label sizes.
// Pure — no DOM, no network — unit tested in tests/unit.

export const LANGS = { he: { dir: 'rtl', name: 'עברית' }, en: { dir: 'ltr', name: 'English' } };

export const TEXT = {
  he: {
    title: 'מסירת כביסה',
    intro: 'מלאו את הפרטים, והמדבקות יודפסו. הדביקו מדבקה אחת על כל שקית.',
    name: 'שם מלא', phone: 'מספר טלפון', bags: 'כמה שקיות?',
    submit: 'שליחה והדפסת מדבקות', sending: 'שולח…',
    less: 'פחות', more: 'עוד',
    thanks: (n) => `תודה, ${n}!`,
    yourNo: 'מספר ההזמנה שלך',
    stick: (b) => (b === 1 ? 'הדביקו את המדבקה על השקית.' : `הדביקו מדבקה אחת על כל אחת מ־${b} השקיות.`),
    welcomeBack: 'שמחים לראותך שוב.',
    printAgain: 'הדפסה חוזרת', done: 'סיום',
    resetIn: (s) => `המסך יתאפס בעוד ${s} שניות`,
    errName: 'נא להקליד שם מלא.', errPhone: 'נא להקליד מספר טלפון תקין.',
    errBags: (max) => `מספר השקיות חייב להיות בין 1 ל־${max}.`,
    errServer: 'משהו השתבש. נסו שוב, או פנו למשרד.',
    errOffline: 'אין חיבור לאינטרנט. נסו שוב בעוד רגע.',
    exitTitle: 'יציאה ממצב טאבלט', exitPrompt: 'הקלידו את סיסמת חשבון הטאבלט כדי לצאת.', password: 'סיסמה', exit: 'יציאה', cancel: 'ביטול',
    errPassword: 'סיסמה שגויה.',
  },
  en: {
    title: 'Laundry drop-off',
    intro: 'Fill in your details and your labels will print. Put one label on each bag.',
    name: 'Full name', phone: 'Phone number', bags: 'How many bags?',
    submit: 'Submit & print labels', sending: 'Sending…',
    less: 'Fewer', more: 'More',
    thanks: (n) => `Thank you, ${n}!`,
    yourNo: 'Your order number',
    stick: (b) => (b === 1 ? 'Put the label on your bag.' : `Put one label on each of your ${b} bags.`),
    welcomeBack: 'Welcome back.',
    printAgain: 'Print again', done: 'Done',
    resetIn: (s) => `This screen resets in ${s} seconds`,
    errName: 'Please type your full name.', errPhone: 'Please type a valid phone number.',
    errBags: (max) => `Number of bags must be from 1 to ${max}.`,
    errServer: 'Something went wrong. Please try again, or ask the office.',
    errOffline: 'No internet connection. Please try again in a moment.',
    exitTitle: 'Leave tablet mode', exitPrompt: "Type the tablet account's password to leave.", password: 'Password', exit: 'Leave', cancel: 'Cancel',
    errPassword: 'Wrong password.',
  },
};

// Label sizes offered in Settings. css = the @page size used when printing.
export const LABEL_SIZES = {
  '4x6': { label: '4 × 6 in (shipping label printers: Rollo, Zebra, Munbyn…)', css: '4in 6in' },
  '62mm': { label: '62 × 100 mm (Brother QL)', css: '62mm 100mm' },
  '2.25x1.25': { label: '2.25 × 1.25 in (Dymo small)', css: '2.25in 1.25in' },
  letter: { label: 'Full page (regular printer)', css: 'letter' },
};

export const phoneDigits = (p) => String(p ?? '').replace(/\D/g, '');

// Returns { ok, errors: { name?, phone?, bags? }, value } using the chosen language's wording.
export function checkKiosk(v, maxBags, lang = 'he') {
  const t = TEXT[lang] || TEXT.he;
  const name = String(v.name ?? '').trim().replace(/\s+/g, ' ');
  const phone = String(v.phone ?? '').trim();
  const bags = Number(v.bags);
  const errors = {};
  if (name.length < 2 || name.length > 80) errors.name = t.errName;
  const d = phoneDigits(phone).length;
  if (d < 7 || d > 15) errors.phone = t.errPhone;
  if (!Number.isInteger(bags) || bags < 1 || bags > maxBags) errors.bags = t.errBags(maxBags);
  return { ok: !Object.keys(errors).length, errors, value: { name, phone, bags } };
}

// One label per bag: [{ index: 1, of: 3 }, …]
export function labelPages(bags) {
  const n = Math.max(1, Math.min(100, Number(bags) || 1));
  return Array.from({ length: n }, (_, i) => ({ index: i + 1, of: n }));
}
