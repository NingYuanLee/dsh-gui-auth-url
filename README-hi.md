# dsh-gui-auth-url

[![CI](https://github.com/NingYuanLee/dsh-gui-auth-url/actions/workflows/ci.yml/badge.svg)](https://github.com/NingYuanLee/dsh-gui-auth-url/actions/workflows/ci.yml) [![npm](https://img.shields.io/npm/v/dsh-gui-auth-url.svg)](https://www.npmjs.com/package/dsh-gui-auth-url) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE) [![Node >=22.19](https://img.shields.io/badge/node-%3E%3D22.19.0-339933.svg)](#compatibility) [![dsh](https://img.shields.io/badge/dsh-%3E%3D0.2.1--rc.2%20%3C0.3.0--0%20%7C%7C%20%3E%3D0.2.2--0%20%3C0.3.0--0-6f42c1)](#compatibility) [![topic: dsh-plugin](https://img.shields.io/badge/topic-dsh--plugin-6f42c1.svg)](https://github.com/topics/dsh-plugin) [![GitHub stars](https://img.shields.io/github/stars/NingYuanLee/dsh-gui-auth-url?style=social)](https://github.com/NingYuanLee/dsh-gui-auth-url/stargazers) [![powered by dsh](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)

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

आधार URL पहले `webApp.getAdvertisedUrl()`, फिर `webServer.getOrigin()`, और अंत में प्रोटोकॉल + लूपबैक पोर्ट से हल होता है। टोकन तभी जुड़ता है जब आधार निरपेक्ष `http` या `https` हो, उसमें उपयोगकर्ता नाम या पासवर्ड न हो, और होस्ट लूपबैक हो (`127.0.0.0/8`, `localhost`, या `::1`)। गैर-लूपबैक होस्ट केवल तभी स्वीकार होता है जब प्लगइन कॉन्फ़िग ठीक `allowPublic: true` हो। लौटी URL का origin वही होना चाहिए और ठीक एक `token` होना चाहिए। आधार अमान्य हो तो `authenticatedUrl` से पहले इनकार होता है, और त्रुटि पाठ में URL नहीं होता।

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

पैकेज npm पर `dsh-gui-auth-url` नाम से प्रकाशित है। स्रोत भंडार GitHub है।

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

`/dsh-web` मानव-पक्ष है: इसे GUI के इनपुट बॉक्स में लिखें और प्लगइन **अलग** `dsh web` Host शुरू करता है — अपना अस्थायी `DSH_HOME` और सिस्टम द्वारा चुना गया पोर्ट — फिर उस URL को डिफ़ॉल्ट ब्राउज़र में खोलता है। डेस्कटॉप संस्करण के चल रहे सेशन से कुछ साझा नहीं होता, इसलिए वह GUI अलग और छोड़ने योग्य है। दोबारा चलाने पर इंस्टेंस जगह पर रीस्टार्ट होता है: अस्थायी DSH_HOME और इंस्टॉल किए प्लगइन सुरक्षित रहते हैं, पोर्ट वही रहता है और केवल लॉन्च टोकन बदलता है। यह इंस्टेंस सत्र का प्रबंधित बैकग्राउंड कार्य है: यह सत्र की "बैकग्राउंड कार्य" सूची में दिखता है, और वहाँ रद्द करने पर प्रक्रिया बंद होकर अस्थायी निर्देशिका हट जाती है। जब Host मशीन पर खोलने के लिए ब्राउज़र न हो, तो profile पैच में `openBrowser: false` सेट करें; तब कमांड केवल लिंक दिखाता है।

profile पैच में `shareApiKey: true` सेट करें; प्लगइन उपलब्ध `DEEPSEEK_API_KEY` (पहले वंशानुगत environment, फिर credentials store) को environment variable के रूप में अलग Host को देता है, ताकि वह दोबारा लॉगिन किए बिना मॉडल से बात कर सके; कुंजी अस्थायी निर्देशिका में नहीं लिखी जाती और हर टर्न वही खाता खर्च करता है।

एक साथ अधिकतम 4 इंस्टेंस चलते हैं (profile पैच में `maxInstances` से 1–32 तक समायोज्य); सीमा पार होने पर नया स्टार्ट विफल होकर पहले एक रोकने को कहता है — हर इंस्टेंस एक पूरा `dsh web` प्रोसेस है, इसलिए यह सीमा जमावट रोकती है। जान-बूझकर रोका गया इंस्टेंस कार्य सूची में «रद्द» दिखता है, «विफल» नहीं।

**जगह पर रीस्टार्ट**: चालू इंस्टेंस होने पर `/dsh-web` उसे अपने आप रीस्टार्ट करता है (ज़बरदस्ती के लिए `/dsh-web restart` लिखें, या एजेंट `dsh_web_restart` टूल से)। रीस्टार्ट अस्थायी `DSH_HOME` रखता है और जब संभव हो **वही पोर्ट** दोबारा उपयोग करता है: प्रोसेस और टोकन नए होते हैं, लेकिन ब्राउज़र कुकी `host:port` से बंधी होती है और उसका साइनिंग सीक्रेट उसी अस्थायी निर्देशिका में होता है, इसलिए पहले से खुला टैब रीलोड के बाद चलता रहता है; पोर्ट व्यस्त होने पर ही यादृच्छिक पोर्ट पर लौटता है (परिणाम बताता है)। इंस्टॉल किए प्लगइन, कॉन्फ़िगरेशन और अंदरूनी सेशन बने रहते हैं; सामान्य स्टॉप पूरी अस्थायी निर्देशिका मिटा देता है। सामान्य उपयोग: अस्थायी इंस्टेंस में प्लगइन इंस्टॉल करें, लागू करने के लिए `/dsh-web` फिर चलाएँ, और अंत में रोक दें — डेस्कटॉप पर कुछ भी इंस्टॉल नहीं रहता।

अवशेष जमा होने से रोकने के लिए हर अस्थायी home में `instance.json` (host PID, Desktop PID, पोर्ट) लिखा जाता है। प्लगइन अरंभ पर `%TEMP%/dsh-web-gui-*` स्कैन करता है, जिनके host या Desktop प्रोसेस मर चुके हैं उन homes को हटाता है, और बचे प्रोसेस को केवल तब समाप्त करता है जब उसका पोर्ट अब भी DSH का 401 हस्ताक्षर लौटाता हो; बिना मार्कर वाली पुरानी निर्देशिकाएँ 24 घंटे बाद साफ़ होती हैं। रोकते समय Windows पर पूरा प्रोसेस ट्री समाप्त किया जाता है।

**स्टार्ट आर्ग्युमेंट।** सभी वैकल्पिक हैं और जैसे हैं वैसे चलाए गए `dsh web` को भेजे जाते हैं। हर एक की कीमत है:

- `install` (string[]): पैकेज spec की सूची, जो host शुरू होने से पहले अस्थायी `DSH_HOME` में `dsh plugin --profile web add` से इंस्टॉल होती है। स्थानीय या प्रकाशित प्लगइन को फेंकने योग्य इंस्टेंस में आज़माने का यही तरीका है। **कीमत:** pnpm इन पैकेजों की lifecycle स्क्रिप्ट (`postinstall` आदि) आपके उपयोगकर्ता के रूप में चलाता है, इसलिए वही पैकेज लिखें जिन्हें आप चलाने को तैयार हैं; इंस्टॉल विफल होने पर अस्थायी निर्देशिका हट जाती है और त्रुटि के साथ इंस्टॉल आउटपुट की पूँछ आती है, आधा बना इंस्टेंस नहीं बचता। डिफ़ॉल्ट रूप से अनुमत; profile पैच में `allowInstall: false` से `install` वाला हर अनुरोध अस्वीकार हो जाता है।
- `host` (string): बाइंड पता। ठोस IPv4 या IPv6 लिटरल होना चाहिए — `0.0.0.0`, `::` और `*` अस्वीकार हैं, क्योंकि वाइल्डकार्ड इंस्टेंस को हर इंटरफ़ेस पर प्रकाशित कर देता है। केवल `allowPublic: true` के साथ स्वीकार्य।
- `public_url` (string): घोषित रूट URL, निरपेक्ष `http`/`https`, बिना उपयोगकर्ता-पासवर्ड। वही `allowPublic` द्वार।
- `tls_cert` और `tls_key` (string): PEM प्रमाणपत्र और कुंजी पथ, जोड़ी में देने होंगे। वही द्वार। TLS केवल ट्रांसपोर्ट एन्क्रिप्ट करता है; छपे हुए token को साझा करने योग्य सुरक्षित नहीं बनाता।
- `trusted_host` (string[]): `/api` ट्रस्ट फ़ेंस द्वारा अतिरिक्त स्वीकार्य authority। वही द्वार।
- `port` (integer, 0–65535): सुनने का पोर्ट; `0` सिस्टम को चुनने देता है। `dsh_web_restart` जानबूझकर `port` नहीं लेता — रीस्टार्ट वही पोर्ट दोबारा उपयोग करता है ताकि खुला टैब चलता रहे।

`allowPublic` चालू करना ही एकमात्र सेटिंग है जो नुकसान का दायरा बढ़ाती है: इंस्टेंस लूपबैक से बाहर जवाब देने लगता है और उस नेटवर्क तथा प्रमाणित सत्र के बीच केवल वही token है। लूपबैक डेस्कटॉप profile पर इसे सेट न करें।

**पूरा चक्र: स्थानीय प्लगइन को फेंकने योग्य इंस्टेंस में आज़माएँ।** «इंस्टॉल → लागू करने के लिए रीस्टार्ट → सत्यापन → सफ़ाई» को साफ़ चक्र बनाता है यह तथ्य कि `dsh_web_restart` भी `install` लेता है:

```text
1. dsh_web_start()
   -> { "url": "http://127.0.0.1:49312/?token=...", "jobId": "job-..." }

2. dsh_web_restart({ "install": ["D:/tools/dsh-plugins/dsh-gui-auth-url"] })
   अस्थायी DSH_HOME में `dsh plugin --profile web add` से इंस्टॉल करता है,
   फिर host बदल देता है: पोर्ट खाली हो तो वही, token नया।

3. सत्यापन: लौटी url को navigate_page/curl से खोलें, या
   dsh_web_status() -> { "running": true, "install": [...], "exposed": false, ... }
   प्लगइन का टूल और कमांड केवल उसी इंस्टेंस में मौजूद हैं।

4. dsh_web_stop() -> { "stopped": true }
   प्रोसेस ट्री समाप्त, अस्थायी निर्देशिका हटी; डेस्कटॉप profile को कभी छुआ नहीं गया।
```

नए इंस्टेंस के लिए `dsh_web_start({ "install": [...] })` चरण 1 और 2 को एक कॉल में मिला देता है। दोनों में सब कुछ `%TEMP%/dsh-web-gui-*` में जाता है, और रीस्टार्ट वही निर्देशिका रखता है, इसलिए इंस्टॉल किया हुआ बना रहता है।

एजेंट के लिए पाँच प्रवेश हैं और वे बदले जा सकने वाले नहीं: `gui_auth_url` **मौजूदा डेस्कटॉप प्रोसेस** का पता देता है (जो GUI आप देख रहे हैं; केवल पढ़ने योग्य, कोई साइड इफ़ेक्ट नहीं); `dsh_web_start` इस सत्र का **अस्थायी इंस्टेंस** शुरू या पुनः उपयोग करता है और उसका `url` व `jobId` देता है (ब्राउज़र नहीं खोलता); `dsh_web_restart` उस host को जगह पर बदलता है और अस्थायी निर्देशिका रखता है; `dsh_web_stop` उसे रोकता है, अस्थायी निर्देशिका हटाता है और `{ stopped }` देता है; `dsh_web_status` बिना कुछ बदले बताता है — `running`, और इंस्टेंस हो तो `url`, `jobId`, `startedAt`, `home`, `port`, `sharedKey`, `install` व `exposed`, साथ में `runningCount` और `maxInstances`। कार्य सूची, `job_kill` या `dsh_web_stop` से रोकने का अंतिम परिणाम एक ही है।

खाली सेशन (अभी कोई संदेश नहीं) में `/dsh-web` नहीं चलाया जा सकता: DSH ऐसे सेशन को सूची से फ़िल्टर कर देता है, इसलिए सेशन बदलने पर वह गायब हो जाएगा और इंस्टेंस का स्टॉप नियंत्रण खो जाएगा। कमांड सीधे संदेश देता है कि पहले कुछ भेजें या मौजूदा सेशन में जाएँ; यह संदेश इनपुट बॉक्स के ऊपर दिखता है, क्योंकि खाली सेशन ट्रांसक्रिप्ट नहीं दिखाता जहाँ परिणाम सामान्यतः दिखते हैं।

साथ ही, पूरा `/dsh-web` लिखने पर `/` मेनू का हाइलाइट अगली कैंडिडेट पर रह सकता है और Enter उसे चुन लेगा; माउस से «Temporary Authenticated DSH Web» पंक्ति चुनें।

## Security

- URL में इस प्रक्रिया का लॉन्च टोकन है: यह साइन-इन सत्र के बराबर क्रेडेंशियल है और केवल Host प्रक्रिया के जीवित रहने तक काम करता है।
- इसे लॉग में न लिखें, रिपॉज़िटरी में कमिट न करें और चैट में पेस्ट न करें; नया पाने के लिए टूल फिर से कॉल करें।
- सफल कॉल टोकन को सेशन ट्रांसक्रिप्ट और बाद की मॉडल रिक्वेस्ट में रखती है। «लॉग में न लिखें» होस्ट को परिणाम सहेजने से नहीं रोकता।
- प्लगइन `.credentials.yaml` नहीं पढ़ता और कुकी नहीं बनाता।
- गैर-लूपबैक URL (`--public-url`, LAN पता, या `0.0.0.0`) तब तक अस्वीकार होते हैं जब तक कॉन्फ़िग ठीक `allowPublic: true` न हो।
- अलग इंस्टेंस असली `dsh web` चाइल्ड प्रोसेस है। `shareApiKey: true` (डिफ़ॉल्ट) पर वह इस प्रोसेस की `DEEPSEEK_API_KEY` environment से पाता है: अस्थायी निर्देशिका में नहीं लिखी जाती और न छपती है, पर उसी उपयोगकर्ता का कोई भी प्रोसेस उसे पढ़ सकता है, और अंदर का हर टर्न वही खाता खर्च करता है। `shareApiKey: false` इसे बंद करता है।
- `install` दिए गए पैकेजों की pnpm lifecycle स्क्रिप्ट आपके उपयोगकर्ता के रूप में चलाता है। spec पर वर्ण-सत्यापन होता है (रिक्त स्थान, कोट या `&|<>^` नहीं), जो shell मेटाकैरेक्टर इंजेक्शन रोकता है, पर सही-आकार वाले दुर्भावनापूर्ण पैकेज के बारे में कुछ नहीं कहता। `allowInstall: false` इंस्टॉल अस्वीकार करता है।
- एक्सपोज़र आर्ग्युमेंट (`host`, `public_url`, `tls_cert`/`tls_key`, `trusted_host`) केवल `allowPublic: true` पर स्वीकार होते हैं, और `host` तब भी वाइल्डकार्ड अस्वीकार करता है। चालू करने पर पहुँचने योग्य नेटवर्क ही token का दर्शक है; TLS उस दर्शक को घटाता नहीं।
- रोकते समय प्रोसेस ट्री समाप्त होता है (Windows पर `taskkill /T`) और अस्थायी निर्देशिका हटती है। स्टार्टअप स्वीप बचे प्रोसेस को केवल तब मारता है जब उसका दर्ज पोर्ट अब भी DSH का 401 हस्ताक्षर लौटाता हो, इसलिए पुनः उपयोग हुआ PID गलती से नहीं मरता।
- इसका [Discussion #8678](https://github.com/deepseek-ai/deepseek-harness/discussions/8678) (सैंडबॉक्स में सीक्रेट पढ़कर कुकी बनाना) से कोई संबंध नहीं है: यह प्लगइन उस सीक्रेट को कभी नहीं छूता।

## Compatibility

| आइटम | मान |
|---|---|
| dsh | `>=0.2.1-rc.2 <0.3.0-0 \|\| >=0.2.2-0 <0.3.0-0` |
| Node | `>=22.19.0` |
| सत्यापित | dsh `0.2.1-rc.2` और `0.2.2-rc.1`, Windows x64, desktop और web प्रोफ़ाइल |
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

**`dsh_web_start` `install` अस्वीकार करता है।** या profile में `allowInstall: false` है, या किसी spec में `[A-Za-z0-9@._~:/\\+=%-]` से बाहर का वर्ण (रिक्त स्थान, कोट, `&|<>^`) है। spec ठीक करें, या profile पैच में इंस्टॉल फिर चालू करें।

**इंस्टॉल विफल और कोई इंस्टेंस नहीं दिखता।** यही अपेक्षित है: अस्थायी निर्देशिका हट जाती है और त्रुटि के साथ इंस्टॉल आउटपुट की पूँछ आती है। वह पूँछ पढ़ें — प्रायः संस्करण असंगति (`engines.dsh`, ऊपर की छूट) या registry/नेटवर्क विफलता होती है।

**`dsh_web_start` `host` / `public_url` / `tls_cert` / `tls_key` / `trusted_host` अस्वीकार करता है।** एक्सपोज़र आर्ग्युमेंट के लिए ठीक `allowPublic: true` चाहिए; और वाइल्डकार्ड (`0.0.0.0`, `::`, `*`) तब भी अस्वीकार है — ठोस पता दें और रिवर्स प्रॉक्सी या टनल प्लगइन के बाहर रखें।

**रीस्टार्ट ने URL अमान्य कर दिया।** केवल पोर्ट दोबारा उपयोग होता है, और वह भी खाली होने पर; token हर स्टार्ट और रीस्टार्ट पर बदलता है, इसलिए पुराने लिंक 401 देते हैं। `dsh_web_status` से मौजूदा `url` लें।

**`dsh_web_stop` कहता है कुछ नहीं रुका।** उस समय इस सत्र में इंस्टेंस नहीं था — पहले रुक चुका, कार्य सूची से रद्द हुआ, या `job_kill` से बंद हुआ। विफलता मानने से पहले `dsh_web_status` से पुष्टि करें।

## Development

```bash
node --test test/*.test.js
node --check src/index.js && node --check src/auth-url.js && node --check src/api-key.js && node --check src/command.js && node --check src/isolated-tool.js && node --check src/isolated-web.js && node --check client.js
npm run check:pack
```

```text
src/auth-url.js      आधार URL समाधान और Host कॉल (शुद्ध फ़ंक्शन)
src/api-key.js       अस्थायी Host के लिए DEEPSEEK_API_KEY समाधान
src/command.js       /dsh-web कमांड: स्टार्ट/स्वतः रीस्टार्ट और ब्राउज़र खोलना
src/isolated-web.js  प्रति-सेशन इंस्टेंस प्रबंधक (spawn, restart, stop, sweep)
src/isolated-tool.js एजेंट टूल dsh_web_start / dsh_web_restart / dsh_web_stop / dsh_web_status
src/index.js         Cordis प्रवेश: gui_auth_url + इंस्टेंस सतह
client.js            ब्राउज़र आधा: कमांड लेबल/आइकन, छिपा alias, सूचना
locale/              डिस्प्ले मेटाडेटा (en, zh, es, pt, hi)
test/                node:test सूट, पैकेजिंग अपरिवर्तनीय सहित
scripts/             prepublishOnly और CI द्वारा उपयोग किया गया tarball जाँच
```

प्लगइन एक केवल-पढ़ने योग्य टूल, चार इंस्टेंस टूल और एक मानव कमांड पंजीकृत करता है; `ctx.tools.register` जो disposer लौटाता है वह Cordis के स्वामित्व में है, इसलिए अनलोड या हॉट-रीलोड पर साफ़ हट जाता है।

`v*` टैग पुश करने पर `.github/workflows/publish.yml` चलता है, जो **trusted publishing (OIDC)** के ज़रिए npm पर प्रकाशित करता है: वर्कफ़्लो में कोई npm टोकन नहीं होता और उसे रिपॉज़िटरी secret की ज़रूरत नहीं पड़ती। पैकेज में इस रिपॉज़िटरी और इस workflow फ़ाइल के लिए पहले से एक trusted publisher दर्ज होना चाहिए — [Releasing](#releasing) देखें। स्थानीय मशीन से मैन्युअल प्रकाशन अभी भी मान्य है।

## Releasing

रिलीज़ एक ही कमांड से: `npm run release -- patch|minor|major` (केवल पूर्वावलोकन के लिए `--dry-run` जोड़ें, कुछ भी नहीं बदलता)। पहले पूरी जाँच (टेस्ट, सिंटैक्स, पैकेजिंग) चलती है और विफल होने पर कुछ भी बदले बिना रुक जाती है; फिर संस्करण बढ़ता है, कमिट, टैग और पुश होते हैं। टैग `.github/workflows/publish.yml` को चलाता है, जो **trusted publishing (OIDC)** के ज़रिए npm पर प्रकाशित करता है — न कोई npm टोकन, न रिपॉज़िटरी secret पढ़ा जाता है।

trusted publisher एक बार दर्ज करना होता है। npmjs.com → Packages → `dsh-gui-auth-url` → Settings → Trusted publishing → GitHub Actions पर:

| फ़ील्ड | मान |
|---|---|
| Organization or user | `NingYuanLee` |
| Repository | `dsh-gui-auth-url` |
| Workflow filename | `publish.yml` (केवल फ़ाइल का नाम, एक्सटेंशन सहित, अक्षर-केस बिल्कुल मिलना चाहिए) |
| Environment name | खाली छोड़ें |

यही प्रविष्टि CLI से भी बनाई जा सकती है (npm ≥ 11.15.0, खाते पर 2FA चालू, पैकेज पहले से registry पर):

```bash
npm trust github dsh-gui-auth-url --file publish.yml --repo NingYuanLee/dsh-gui-auth-url --allow-publish
```

`--allow-publish` इस वर्कफ़्लो को `npm publish` चलाने की अनुमति देता है; `npm stage publish` हमेशा अनुमत रहता है। trusted publishing के लिए npm CLI ≥ 11.5.1 और Node ≥ 22.14.0 चाहिए — वर्कफ़्लो प्रकाशन से पहले अपना npm अपग्रेड कर लेता है, और provenance अपने आप जुड़ जाता है।

स्थानीय मशीन से प्रकाशित करने के लिए आधिकारिक तरीका अपनाएँ: `npm login --auth-type=web` दो घंटे का सेशन टोकन देता है, और प्रकाशन के समय 2FA का एक बार का कोड चाहिए:

```bash
npm login --auth-type=web
npm publish --access public --tag latest --otp <code>
```

## Related

- [Discussion #5932](https://github.com/deepseek-ai/deepseek-harness/discussions/5932) — स्थानीय स्क्रिप्ट को Web UI पर 401
- [Discussion #5828](https://github.com/deepseek-ai/deepseek-harness/discussions/5828) — `--no-browser-auth` का अनुरोध, स्वीकार नहीं हुआ
- [Discussion #9085](https://github.com/deepseek-ai/deepseek-harness/discussions/9085) — Desktop को वैध सत्र नहीं मिलता
- [आधिकारिक connection अनुबंध](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/connection/README.md)
