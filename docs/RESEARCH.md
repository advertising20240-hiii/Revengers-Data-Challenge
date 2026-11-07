# Исследование аналогов и журнал источников

Что уже существует в мире оценки качества диалогов, что мы из этого взяли и где это задокументировано. Записи с пометкой **«проверено 2026-11-07»** открыты и прочитаны в день написания; формулировки в кавычках — дословные цитаты из источника. Записи «не перепроверялось сегодня» — из общих знаний, без цитат и чисел.

## 1. Microsoft Dynamics 365 Contact Center — Quality Evaluation Agent (QEA)

Почему важно: Freedom работает на Dynamics 365 и Power Automate (API организаторов — HTTP-триггер Power Automate), поэтому QEA — естественная точка отсчёта для жюри. Позиция Revengers CQA: **дополняет и отображается на QEA**, не заменяет.

| Факт (из документации) | Источник | Что взяли |
|---|---|---|
| Модель: критерии → секции (веса секций в сумме 100 %) → вопросы, «Each question is scored on a scale of 0 to 100»; типы ответов «Yes/No, Multi-select, Single-select, or Descriptive»; у single-select баллы на вариант (пример Excellent = 100, Good = 75 …) | [Use evaluation criteria](https://learn.microsoft.com/en-us/dynamics365/contact-center/use/evaluation-criteria) — проверено 2026-11-07 | ступенчатые шкалы с баллами на ступень; секции с итогами |
| «Allow Not Applicable responses … the question is excluded from the evaluation score. The score is calculated based only on applicable questions» | там же | N/A исключается из расчёта (у нас — только при разрешении **и** выполненном условии, с обязательной причиной) |
| Критический вопрос: «If a critical question is answered with a fail option, the entire evaluation or simulation fails … Scoring doesn't change when a critical question causes an evaluation to fail» | там же | флаг грубых ошибок отдельно от балла |
| Версии: «Each edit and publish action increments the evaluation criteria version … restore any version to make it the current one» | там же | версии чек-листа, восстановление, diff |
| Симуляция: «run a simulation test with real case and conversation data … By default, the simulation runs on the 25 most recent records … The results don't affect records or quality metrics» | там же | режим симуляции на N выбранных диалогах без сохранения |
| Инструкции трёх уровней (criteria / question / answer); «Put exclusion rules first»; «Specify the exact data source … Name the exact record type»; «Require evidence from the source» | там же | `instructions`, `guidance`, `answer_guidance`; политика «только реплики оператора»; доказательства по строкам |
| Лимиты: «up to 50 questions», «Instructions 2,000 characters», «Question text 300», «Option text 100» | там же | `maxCriteria: 50` на сервере |
| Язык: «You can't change the language after you save a criteria … Evaluation results are returned in the same language» | там же | объяснения на языке чек-листа (русский) при RU/KZ/EN транскриптах |
| Роли: Quality Administrator / Quality Manager / Quality Evaluator | [Manage quality evaluation](https://learn.microsoft.com/en-us/dynamics365/contact-center/administer/manage-quality-evaluation-agent) — проверено 2026-11-07 | роли в `docs/DYNAMICS365.md` |
| Политика: «It isn't intended to be used, and shouldn't be used, to make decisions that affect the employment of an employee or group of employees, including compensation, rewards, seniority» | там же | п. 1 правил использования в `docs/SECURITY.md` |
| Сроки: Conversation evaluation — public preview 24 окт 2025, GA 16 янв 2026 | [Release plan 2025 wave 2](https://learn.microsoft.com/en-us/dynamics365/release-plan/2025wave2/service/dynamics365-contact-center/evaluate-closed-conversations-quality-evaluation-agent) — проверено 2026-11-07 (страница архивная) | контекст для питча: инструмент новый, жюри о нём знает |

Не найдено в проверенных страницах: явного утверждения Microsoft о «no emotion inference». Поэтому отказ от вывода эмоций в `docs/SECURITY.md` сформулирован как **наше** обязательство, не как цитата.

## 2. Dynamics 365 / Dataverse — HTML-веб-ресурсы

| Факт | Источник | Применение |
|---|---|---|
| «An HTML web resource can't contain any code that must run on the server»; относительные пути: «The solution publisher customization prefix becomes a virtual root folder»; параметр `data`: «An optional value that can be passed»; «An HTML web resource can interact with the `Xrm.Page` or `Xrm.Utility` objects within the form by using `parent.Xrm.Page` or `parent.Xrm.Utility`» | [HTML web resources](https://learn.microsoft.com/en-us/power-apps/developer/model-driven-apps/webpage-html-web-resources) — проверено 2026-11-07 | сборка в один файл, хук `parent.Xrm`, `apiBase` через `data` |
| `Xrm.Navigation.openWebResource(webResourceName, windowOptions, data)`; «The **Xrm** object isn't available in HTML web resources … `parent.Xrm.*` will work if the HTML web resource is loaded in a form container» | [openWebResource](https://learn.microsoft.com/en-us/power-apps/developer/model-driven-apps/clientapi/reference/xrm-navigation/openwebresource) — проверено 2026-11-07 | хук пытается `window.Xrm`, затем `parent.Xrm`, иначе работает без контекста |
| Лимит размера: «The Organization.MaxUploadFileSize property determines the maximum size of files that you can upload … The default setting is 5 MB» | [Web resources](https://learn.microsoft.com/en-us/power-apps/developer/model-driven-apps/web-resources) — проверено 2026-11-07 (через поиск, выдержка) | сборка отказывает при ≥ 5 МБ |

## 3. Zendesk QA (ex-Klaus) — AutoQA

| Факт | Источник | Что взяли |
|---|---|---|
| Greeting: агенты без приветствия получают N/A, «unless they're the first agent in the conversation» — тогда отрицательная оценка | [Understanding autoscoring categories](https://support.zendesk.com/hc/en-us/articles/7043747123354-Understanding-autoscoring-categories) — проверено 2026-11-07 | критерий 01 смотрит только первую реплику оператора; бот не засчитывается |
| «Agents and bots are evaluated separately» | там же | оператор оценивается, бот — контекст |
| Tone: при недостатке данных оценки нет, «A missing score won't be treated as neutral or poor» | там же | низкая уверенность → «Требует проверки», а не нейтральный балл |
| N/A при нехватке информации: «AutoQA may sometimes return an "N/A" evaluation … when there is not enough information to provide an accurate rating»; категории с подсветкой фрагментов (highlighting) | [AutoQA FAQ](https://support.zendesk.com/hc/en-us/articles/7043747067546-AutoQA-in-Zendesk-QA-FAQ) — проверено 2026-11-07 (выдержка из поиска) | подсветка строк-доказательств в транскрипте |

## 4. Kaizo — дизайн апелляций на AI-оценку

| Факт | Источник | Что взяли |
|---|---|---|
| Четыре исхода спора: «Score changes», «Criterion changes», «Score stands, reasoning was never explained», «Score stands, agent was wrong» | [How to Dispute an AI QA Score](https://www.kaizo.com/blog/how-to-dispute-an-ai-qa-score/) — проверено 2026-11-07 | таксономия `score_changed / criterion_change / stands_explanation / stands_coaching` |
| Проверяющий не может быть тем, кого оспаривают; для автоматических оценок спор рассматривает человек | там же | независимость проверяющего, «второе мнение» — только черновик |
| Спорная оценка отмечена «under review» везде, исходная остаётся; не используется в «a formal performance conversation, a ranking, or anything tied to pay until it is resolved» | там же | статус `under_appeal`, исключение из рейтингов |
| Метрики: dispute rate, доля подтверждённых, кластеризация по критерию; «dispute rate at or near zero is almost never evidence that the scoring is perfect» | там же | блок метрик споров |
| После подтверждённого спора «check every other score on the same criterion with the same pattern» | там же | предложение «проверить похожие» |
| Прослеживаемость: каждое снятие баллов указывает на критерий, момент в разговоре, версию правила и того, кто может отменить | [QA Score Traceability](https://www.kaizo.com/blog/qa-score-traceability/) — проверено 2026-11-07 (выдержка из поиска) | `evidence`, `rule_applied`, `prompt_version`, роль проверяющего |

## 5. MLflow — калибровка LLM-судьи

| Факт | Источник | Что взяли |
|---|---|---|
| «Cohen's kappa … ≥0.61 trustworthy; <0.40 needs rubric revision»; κ Коэна — для двух оценщиков на категориальных метках | [Fix LLM Judge Consistency](https://mlflow.org/articles/judge-consistency-llm/) — проверено 2026-11-07 (выдержка из поиска) | целевой порог κ ≥ 0.61 на отложенной выборке |
| Измерять согласие κ, а не только accuracy; сначала измерить согласие человек–человек — «a judge cannot be more aligned than its labelers» | [LLM Judge Calibration](https://mlflow.org/articles/llm-judge-calibration) — проверено 2026-11-07 (выдержка из поиска) | честная оговорка в `docs/LIMITATIONS.md`: один разметчик |
| Выравнивание судьи по человеческим меткам на тех же записях; минимум ~10 примеров | [Judge Alignment](https://mlflow.org/docs/latest/genai/eval-monitor/scorers/llm-judge/alignment/) — проверено 2026-11-07 (выдержка из поиска) | цикл обучения на решениях проверяющего (few-shot, без дообучения) |

Общие практики (не перепроверялось сегодня, без цитат): отложенная выборка, 95 % доверительные интервалы, матрицы ошибок, проверка на смещения (снисходительность, длина, позиция), тест–ретест как мера консистентности, а не валидности, перекалибровка после смены промпта/модели.

## 6. Общие практики индустрии QA контакт-центров (не перепроверялось сегодня)

Genesys Cloud, MaestroQA, Observe.AI, Level AI: калибровочные сессии с разбросом по вопросам между оценщиками, авто-провальные категории, коучинговые карточки по агенту, планы выборки, теги причин. Взяли: разрез расхождений по критерию, карточка коучинга оператора (два чаще всего проваленных критерия + примеры строк), очередь по уверенности как выборка для человека.

## 7. Чего мы не нашли у аналогов и делаем сами

- Формула чек-листа Freedom как есть: веса критериев, Да/Нет/N/A, ступени шкал, перераспределение при N/A с точной арифметикой.
- Калибровка против человеческих меток с κ и интервалами на странице продукта.
- Казахский: лексикон приветствий/представлений, второе мнение казахской модели.
- Бесплатные/локальные модели по умолчанию, измеренные задержки и токены вместо счёта.
