import { defaultCountries } from "react-international-phone";

// Fallback country codes when country is not found in language code
export const FALLBACK_COUNTRIES: Record<string, string> = {
  af: "za", // Afrikaans -> South Africa
  ar: "sa", // Arabic -> Saudi Arabia
  be: "by", // Belarusian -> Belarus
  bn: "bd", // Bengali -> Bangladesh
  bs: "ba", // Bosnian -> Bosnia and Herzegovina
  cs: "cz", // Czech -> Czech Republic
  da: "dk", // Danish -> Denmark
  el: "gr", // Greek -> Greece
  en: "us", // English -> United States
  et: "ee", // Estonian -> Estonia
  fa: "ir", // Persian -> Iran
  gu: "in", // Gujarati -> India
  he: "il", // Hebrew -> Israel
  hi: "in", // Hindi -> India
  ja: "jp", // Japanese -> Japan
  ko: "kr", // Korean -> South Korea
  ms: "my", // Malay -> Malaysia
  sv: "se", // Swedish -> Sweden
  uk: "ua", // Ukrainian -> Ukraine
  vi: "vn", // Vietnamese -> Vietnam
  zh: "cn", // Chinese -> China
};

export const FLAGS = defaultCountries.map((country) => {
  const iso2 = country[1];
  const src = "img/flags.svg";
  return { iso2, src };
});

export const FLAG_SOURCES = FLAGS.reduce(
  (acc, flag) => {
    const { iso2, src } = flag;
    acc[iso2] = src;
    return acc;
  },
  {} as Record<string, string>,
);
