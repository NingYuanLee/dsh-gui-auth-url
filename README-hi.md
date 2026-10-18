# dsh-gui-auth-url

[![CI](https://github.com/NingYuanLee/dsh-gui-auth-url/actions/workflows/ci.yml/badge.svg)](https://github.com/NingYuanLee/dsh-gui-auth-url/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

> [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) के लिए तीसरे पक्ष का सामुदायिक प्लगइन। यह DeepSeek का आधिकारिक उत्पाद नहीं है। MIT।

[English](README.md) | [中文](README-zh.md) | [Español](README-es.md) | [Português](README-pt.md) | हिन्दी

चल रहे DeepSeek Harness Web GUI का **प्रमाणित URL** एजेंट टूल के रूप में उपलब्ध कराता है, ताकि ब्राउज़र ऑटोमेशन और स्क्रिप्ट `401 dsh web authentication required` पर अटकने के बजाय सीधे GUI खोल सकें।

## The problem

`dsh --profile web` हर प्रक्रिया के लिए एक यादृच्छिक लॉन्च टोकन बनाता है और उसे केवल एक बार प्रिंट करता है:

```text
dsh web: http://127.0.0.1:3080/?token=...
```

बिना टोकन वाला पता खोलने पर 401 मिलता है। Desktop संस्करण अपनी Host प्रक्रिया यादृच्छिक पोर्ट पर चलाता है और वह पंक्ति कभी प्रिंट नहीं करता, इसलिए कोई भी बाहरी ब्राउज़र या ऑटोमेशन टूल सीधा पता खोलने पर 401 पाता है। अभी `--no-browser-auth` जैसा कोई स्विच नहीं है।

## How it works

प्लगइन Host प्रक्रिया के अंदर चलता है और आधिकारिक सार्वजनिक API `connection.authenticatedUrl(baseUrl)` को कॉल करता है — वही जिससे `dsh web` अपनी प्रिंट की गई URL बनाता है — और परिणाम को टूल परिणाम के रूप में लौटाता है। यह `$DSH_HOME/.credentials.yaml` में मौजूद कुकी-साइनिंग सीक्रेट नहीं पढ़ता और खुद कुकी नहीं बनाता, इसलिए URL इस प्रक्रिया से बंधा हुआ असली first-party सत्र है।

आधार URL पहले `webApp.getAdvertisedUrl()`, फिर `webServer.getOrigin()`, और अंत में प्रोटोकॉल + लूपबैक पोर्ट से हल होता है।

## Install

```bash
dsh plugin --profile web add github:NingYuanLee/dsh-gui-auth-url
```

पैकेज `dsh.bundle.patch` घोषित करता है, इसलिए `dsh plugin add` बंडल को प्रोफ़ाइल में अपने आप जोड़ देता है। DeepSeek Harness को पुनः आरंभ करें।

स्थानीय checkout से:

```bash
git clone https://github.com/NingYuanLee/dsh-gui-auth-url.git
dsh plugin --profile web add ./dsh-gui-auth-url
```

npm अभी प्रकाशित नहीं है; अभी केवल GitHub से वितरण होता है।

पुराने नाम `dsh-gui-session` (0.1.x) से आ रहे हैं तो दोबारा इंस्टॉल करें: पैकेज, Cordis पंक्ति और टूल नाम बदल गए हैं।

## Usage

टूल `gui_auth_url` कोई पैरामीटर नहीं लेता और लौटाता है:

```json
{
  "url": "http://127.0.0.1:3080/?token=...",
  "origin": "http://127.0.0.1:3080",
  "protocol": "http:",
  "host": "127.0.0.1",
  "port": "3080",
  "secure": false
}
```

मॉडल `url` टेक्स्ट देखता है; बाकी फ़ील्ड प्रोग्रामेटिक कॉल के लिए हैं। URL को `navigate_page`, `curl` या किसी भी HTTP क्लाइंट को दें और GUI में प्रवेश करें। DeepSeek Harness को डीबग करते समय chrome-devtools-mcp से GUI का लेआउट, इंटरैक्शन और RPC वास्तव में जाँचने में उपयोगी।

## Security

- URL में इस प्रक्रिया का लॉन्च टोकन है: यह साइन-इन सत्र के बराबर क्रेडेंशियल है और केवल Host प्रक्रिया के जीवित रहने तक काम करता है।
- इसे लॉग में न लिखें, रिपॉज़िटरी में कमिट न करें और चैट में पेस्ट न करें; नया पाने के लिए टूल फिर से कॉल करें।
- प्लगइन `.credentials.yaml` नहीं पढ़ता और कुकी नहीं बनाता; इसकी अनुमति सीमा टर्मिनल में `dsh web` जैसी ही है।
- इसका [Discussion #8678](https://github.com/deepseek-ai/deepseek-harness/discussions/8678) (सैंडबॉक्स में सीक्रेट पढ़कर कुकी बनाना) से कोई संबंध नहीं है: यह प्लगइन उस सीक्रेट को कभी नहीं छूता।

## Compatibility

| आइटम | मान |
|---|---|
| dsh | `>=0.2.1-rc.2 <0.3.0-0` |
| Node | `>=22.19.0` |
| सत्यापित | dsh `0.2.1-rc.2`, Windows x64, desktop और web प्रोफ़ाइल |
| Web संयोजन | `connection` सेवा आवश्यक; बिना Web GUI वाली प्रोफ़ाइल स्पष्ट त्रुटि देती है |

डिस्प्ले मेटाडेटा (`locale/*.json` और निर्यात किया गया `./icon`) Plugins पेज और Settings में कच्चे पैकेज id के बजाय शीर्षक, विवरण और आइकन दिखाता है। कोई बिल्ड चरण नहीं है: सादा ESM JavaScript प्रकाशित होता है।

## Troubleshooting

**इंस्टॉल के बाद टूल नहीं दिखता।** प्रोफ़ाइल के `package.json` में `dsh.profile.bundles` में `dsh-gui-auth-url` जाँचें; असफल इंस्टॉल केवल निर्भरता छोड़ सकता है। DSH पुनः आरंभ करें और `dsh --profile <name> --dump-config` से `gui-auth-url` पंक्ति जाँचें।

**संस्करण मेल न होने पर इंस्टॉल अस्वीकृत।** DSH इंस्टॉल के समय `engines.dsh` (या dsh peer रेंज) जाँचता है। यदि होस्ट घोषित रेंज से बाहर है तो सटीक-संस्करण छूट दें, दोबारा इंस्टॉल करें, और संगत संस्करण आने पर छूट रद्द करें:

```bash
dsh plugin --profile <profile> version-exemptions
dsh plugin --profile <profile> allow-version dsh-gui-auth-url@0.2.1 --dsh-version <runtime> --accept-risk
dsh plugin --profile <profile> revoke-version dsh-gui-auth-url@0.2.1
```

**Windows पर `EPERM: rename ...`।** उस प्रोफ़ाइल का DSH प्रोसेस रोकें, पुरानी `node_modules\dsh-gui-auth-url` निर्देशिका हटाएँ और फिर प्रयास करें।

**"This profile serves no Web GUI"।** प्रोफ़ाइल में `webApp` या `webServer` तथा `connection` होना चाहिए; headless प्रोफ़ाइल में खोलने के लिए GUI नहीं होता।

## Development

```bash
node --test test/*.test.js
node --check src/index.js && node --check src/auth-url.js
npm run check:pack
```

```text
src/auth-url.js    आधार URL समाधान और Host कॉल (शुद्ध फ़ंक्शन)
src/index.js       Cordis प्लगइन प्रवेश: gui_auth_url पंजीकृत करता है
locale/            डिस्प्ले मेटाडेटा (en, zh, es, pt, hi)
test/              node:test सूट, पैकेजिंग अपरिवर्तनीय सहित
scripts/           prepublishOnly और CI द्वारा उपयोग किया गया tarball जाँच
```

प्लगइन केवल एक टूल पंजीकृत करता है; `ctx.tools.register` जो disposer लौटाता है वह Cordis के स्वामित्व में है, इसलिए अनलोड या हॉट-रीलोड पर यह साफ़ हट जाता है।

## Related

- [Discussion #5932](https://github.com/deepseek-ai/deepseek-harness/discussions/5932) — स्थानीय स्क्रिप्ट को Web UI पर 401
- [Discussion #5828](https://github.com/deepseek-ai/deepseek-harness/discussions/5828) — `--no-browser-auth` का अनुरोध, स्वीकार नहीं हुआ
- [Discussion #9085](https://github.com/deepseek-ai/deepseek-harness/discussions/9085) — Desktop को वैध सत्र नहीं मिलता
- [आधिकारिक connection अनुबंध](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/connection/README.md)
- [सामुदायिक प्लगइन रजिस्ट्री](https://dsplugin.app/)
