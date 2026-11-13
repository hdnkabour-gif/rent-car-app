# إعداد OCR متعدد اللغات على Railway — نسخة اختبار فقط

**الحالة:** 2026-11-13 — لا يتم تعديل خدمة production `rent-car-app` تلقائياً. هذا الفرع اختبار مستقل.

## لماذا Dockerfile؟

التطبيق الحالي يعمل بباني `RAILPACK`، ويستخدم Node.js 22؛ إضافة Python وTesseract/Poppler مع كل المكتبات في نفس الحاوية أسهل وأوضح بإعداد Dockerfile المثبت.
المستودع يحتوي `Dockerfile` (يتحقق من اللغات)، و`server/tools/requirements-ocr.txt` بإصدارات Python ثابتة،
و`.github/workflows/ocr-docker.yml` لبناء الصورة في GitHub Actions.

## 1 — إنشاء بيئة مستقلة
- في Railway أنشئ مشروع **Fleetora OCR Staging** منفصلاً أو بيئة staging لا تشارك قاعدة بيانات ولا Volume الإنتاج.
- وصّل GitHub: `hdnkabour-gif/rent-car-app`، الفرع `feat/railway-ocr-multilingual-runtime-20261113`.
- أضف PostgreSQL 16 **جديداً وخاصاً بالتجربة**، واترك بيانات production الأصلية دون تغيير.
- أضف Volume خاصاً لـ staging على `/data` ولا تنقل أو تفصل Volume الإنتاج الحالي.
- من إعدادات Build اختر Dockerfile / Docker builder عند الحاجة، والمسار `Dockerfile` من جذر المستودع.
- حافظ على Start Command المناسب: `npm run start -w server` (وهو CMD الصورة) وPort `8080` حسب التطبيق.
- حتى اجتياز الفحص اترك البيئة خاصة ولا ترسل صور بطاقات شخصية حقيقية.

## 2 — متغيرات staging فقط
تتطلب Fleetora متغيرات التطبيق الاعتيادية وقاعدة بيانات staging:
```text
NODE_ENV=production
HOST=0.0.0.0
DATABASE_URL=<REFERENCE_TO_STAGING_POSTGRES>
APP_ORIGINS=https://<STAGING_DOMAIN>
COOKIE_SECURE=true
STORAGE_DIR=/data/files
WEB_DIST_DIR=/app/web/dist
FLEETORA_OCR_ENABLED=false
FLEETORA_OCR_PYTHON=/opt/fleetora-ocr/bin/python
FLEETORA_OCR_LANG=fra+eng+ara
PYTHONIOENCODING=utf-8
```
احتفظ بالأسرار في Railway Variables، وليس في GitHub أو لقطات الشاشة.
`DATABASE_URL` يجب أن يكون لقاعدة staging **فقط**.

## 3 — التحقق الآلي من الصورة
في GitHub Actions اختر workflow `OCR container smoke test`:
- يقوم `docker build` بتثبيت Tesseract `ara`, `fra`, `eng`.
- يتأكد من أن `pdftoppm` و`python` و`cv2` و`numpy` و`pytesseract` موجودة.
- يشغّل اختبارات Parser للوحات السيارات، الأرقام العربية، كيلومترات العدادات وMRZ التجريبي.
**لا تعتبر الصورة معتمدة إذا فشل هذا الفحص.**

## 4 — تجربة تشغيل الخدمة داخل staging
- افتح Logs وتأكد أن التطبيق يبدأ وأن ترحيلات DB اكتملت دون أخطاء.
- إذا كانت أدوات OCR غير جاهزة، يجب أن تبقى `FLEETORA_OCR_ENABLED=false` وتعمل بقية الميزات.
- بعد اختبار الوثائق **الاصطناعية** والأدوار والصلاحيات، غيّر `FLEETORA_OCR_ENABLED=true` في staging فقط وأعد النشر.
- من واجهة Fleetora الخاصة بالمدير، جرّب وثيقة اصطناعية ثم زر `Analyser localement (OCR)`.
- يجب أن تظهر **اقتراحات قابلة للمراجعة** لا تُحدّث هوية أو عقداً أو رخصة تلقائياً.
- أوقف OCR مرة أخرى، وجرّب الاستمرار في استعمال بقية التطبيق بشكل طبيعي.
- لا يوجد بعد زر نهائي في واجهة Fleetora لتحليل لوحة السيارة أو عداد `kilométrage`:
  يحتوي الفرع على محرك `server/tools/vehicle_ocr.py` واختبارات Parser فقط. يحتاج ربطه
  بواجهة صور السيارة والصلاحيات وسجل التغيير واختبارات الهاتف قبل تشغيله للمستخدمين.

## 5 — المتطلبات العملية للصور
- CIN / permis / passeport: صورة واضحة لكامل الوثيقة، إضاءة جيدة، تجنب انعكاس الفلاش.
- Carte grise / assurance / visite technique: OCR متعدد اللغات + نموذج حقول خاص بكل نوع، مراجعة رقم اللوحة وتواريخ الانتهاء.
- Plaque d'immatriculation: اقتراح أرقام/حروف عربية مع اختبار تخطيط اللوحات المغربية؛ يجب تدقيق الأحرف المتشابهة.
- Compteur kilométrique: قص منطقة العداد، عرض `ODO` و`Trip` إن ظهرا، ثم تأكيد القراءة يدوياً.
- Photos état véhicule: صور الأضرار والخدوش منفصلة مع تسجيل موضع الضرر مراجعاً من الموظف؛ Tesseract **لا يكشف خدشاً أو صدماً تلقائياً**.
- الأرقام `٠١٢٣٤٥٦٧٨٩` و`۰۱۲۳۴۵۶۷۸۹` تُحوّل إلى `0123456789` للبحث والمقارنة، مع حفظ الصورة الأصلية.

## 6 — متى ننشر في الإنتاج؟
بعد CI ناجح + Docker smoke ناجح + اختبارات هاتف Android/iPhone + فحص OCR بصور اصطناعية من عدة أنواع +
مراجعة صلاحيات الزبون والموظف والمدير + سياسة الخصوصية والاحتفاظ بالبيانات +
نسخ احتياطي واسترجاع ناجح على staging + موافقة صاحب الشركة.
لا تدمج هذه الفروع ولا توجه خدمة الإنتاج إليها قبل تحقق الشروط.
