# Revengers CQA — Conversation Quality Analytics

[![CI](https://github.com/advertising20240-hiii/Revengers-Data-Challenge/actions/workflows/ci.yml/badge.svg)](https://github.com/advertising20240-hiii/Revengers-Data-Challenge/actions/workflows/ci.yml)
![Node 22](https://img.shields.io/badge/node-%E2%89%A5%2022.5-339933)
![зависимостей: 0](https://img.shields.io/badge/npm%20deps-0-blue)
[![MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

Автоматическая, **объяснимая** и **оспариваемая** оценка качества диалогов поддержки по настраиваемому чек-листу. Прототип для NU Data Challenge × Freedom Broker (кейс «Conversation Quality Analytics»). RU · KZ · EN, чаты и звонки. Репозиторий: <https://github.com/advertising20240-hiii/Revengers-Data-Challenge>.

> Каждый балл — аргумент: правило чек-листа, реплики-доказательства, проверенный участок, уверенность. Его можно оспорить, проверяющий решает, система пересчитывает — и согласие с человеком измерено, а не обещано.

[English section below](#english)

---

## Содержание

1. [Что это](#что-это)
2. [Быстрый старт](#быстрый-старт)
3. [Как пользоваться](#как-пользоваться)
4. [Архитектура](#архитектура)
5. [Модели, маршрутизация и стоимость](#модели-маршрутизация-и-стоимость)
6. [Результаты для организаторов](#результаты-для-организаторов)
7. [Калибровка](#калибровка)
8. [Тесты и CI](#тесты-и-ci)
9. [Безопасность](#безопасность)
10. [Dynamics 365](#dynamics-365)
11. [Ограничения](#ограничения)
12. [Команда и лицензия](#команда-и-лицензия)

## Что это

| Контур | Что умеет |
|---|---|
| **Чек-лист** | Редактор критериев: текст, секция, вес, тип ответа (Да/Нет · Да/Нет/N/A · шкала со ступенями · флаг без баллов), доступность и условие N/A, подсказки модели по критерию и по каждому ответу. 6 шаблонов (в т. ч. детерминированное правило «Скорость первой реакции»). **Версии** (сохранить, активировать, diff, восстановить), **замена критерия**, **симуляция** черновика на N диалогах без записи. Новый критерий применяется через настройки, без кода. |
| **Оценка** | Загрузка набора по `group_id` через API организаторов (с кэшем), загрузка/вставка JSON того же формата. Оценка одного диалога или всех — с прогрессом, отменой, возобновлением. Оценивается **только оператор**; бот и системные события — контекст. |
| **Результат** | По критерию: ответ, баллы, вес и **эффективный вес** после перераспределения, объяснение на русском, реплики-доказательства с цитатой и ссылкой, **проверенный участок** для «Нет», **причина N/A**, применённое правило, уверенность, источник решения (модель / правило / проверяющий). Итог, секции, флаг грубой ошибки с типом. Модель, версия промпта, задержка. |
| **Карточка** | Транскрипт и результат рядом; клик по доказательству подсвечивает реплику; для звонков — перемотка аудио. Deep link `#/c/<id>/l/<строка>`. Переключатель версий чек-листа. |
| **Апелляция** | Оператор оспаривает критерий с комментарием → статус «под апелляцией» везде, исходная оценка видна. Проверяющий видит спор, доказательства, фрагмент; опционально — «второе мнение» модели (рекомендация, не решение). |
| **Решение** | Подтвердить/изменить с обоснованием; четыре исхода (балл изменён · критерий нужно менять · верно, пробел в объяснении · верно, коучинг). Пересчёт общим движком; история «исходная → решение → финал». Спорные оценки исключены из рейтингов операторов. |
| **Калибровка** | Согласие модели с человеческими метками на 65 DEV-диалогах: точность и κ Коэна по критериям с 95 % ДИ, отдельно на отложенной выборке (20 диалогов), матрицы ошибок, список расхождений со ссылками на диалоги, полнота/точность по грубым ошибкам. |
| **Инсайты** | Распределение итогов, доля провалов по критерию, язык/канал, эскалации, время первой реакции, удержание в звонках, список грубых ошибок, карточки операторов. Экспорт CSV. |

Формула — из чек-листа организаторов, один в один: Да = полный вес, Нет = 0, шкала пропорционально; N/A исключается, веса перераспределяются; округление до двух знаков точной арифметикой (`60.5 / 80 → 75.63`); грубая ошибка — отдельный флаг, итог не меняет (в DEV диалог `p1-kz-013` имеет итог 92.31 и флаг «обход компании»). Подробно — [docs/SCORING_POLICY.md](docs/SCORING_POLICY.md).

## Быстрый старт

Нужны Node.js ≥ 22.5 и git. Внешних npm-зависимостей **нет** — `npm install` ничего не скачивает.

```bash
git clone https://github.com/advertising20240-hiii/Revengers-Data-Challenge.git
cd Revengers-Data-Challenge
npm install            # зависимостей нет; завершается мгновенно
npm start              # → http://localhost:8080
```

**Без ключей и без сети** приложение работает сразу: при первом запуске сервер устанавливает чек-лист v1 (`config/checklist.v1.json`), загружает DEV-набор из `data/dev/DEV.json` (65 диалогов) и 65 сохранённых оценок из `data/seed/DEV.evaluations.json`. Все карточки, доказательства, апелляции, калибровка и инсайты доступны; новые оценки запускать нельзя (баннер «Модель недоступна»). Проверить: `npm test` и `curl http://localhost:8080/api/health` (ожидается `"counts":{"conversations":65,"evaluations":65,...}`).

**Для живой оценки** скопируйте `.env.example` в `.env` и выберите бесплатный провайдер:

- **alem.plus** (основной): `ALEM_BASE_URL`, `ALEM_API_KEY` и идентификаторы моделей `ALEM_MODEL_JUDGE` (судья), `ALEM_MODEL_VERIFIER`, `ALEM_MODEL_KZ`, `ALEM_MODEL_FALLBACK` из списка моделей платформы.
- **Ollama локально** (данные не покидают машину): `ollama pull qwen2.5:7b`, `ollama serve`; остальное уже в `.env.example`.

`CQA_PROVIDER` пустой = автоматически alem → ollama → offline. Платные облачные провайдеры заблокированы (`CQA_ALLOW_CLOUD=0`). Все переменные с комментариями — в [.env.example](.env.example).

## Как пользоваться

### Загрузить набор (DEV / контрольный)
«Диалоги» → **«Загрузить набор»** → `group_id` (`DEV` или контрольный от организаторов) → данные приходят через сервер (API организаторов не допускает запрос из браузера) и кэшируются в `data/raw/<group_id>.json`. Альтернативы: **«Загрузить файл»** / вставить JSON в формате API. Из командной строки:

```bash
curl -X POST localhost:8080/api/datasets/fetch -H 'Content-Type: application/json' -d '{"group_id":"DEV"}'
```

### Оценить
«Диалоги» → **«Оценить все»** или выбрать строки → **«Оценить выбранные»** (прогресс, отмена, возобновление; частичные результаты видны сразу; уже оценённые критерии берутся из кэша). CLI: `npm run evaluate -- --group DEV`.

### Прочитать результат
Карточка `#/c/<id>`: слева транскрипт с номерами строк, справа итог, секции и критерии. «Доказательство» → подсветка строки (для звонка — перемотка аудио). «Проверенный участок» у «Нет», «Условие N/A» у N/A, «Правило», «Уверенность». Ссылка на строку: `#/c/p1-ru-003/l/14`.

### Оспорить и решить
Роль **«Оператор»** (шапка) → критерий → **«Оспорить»** → комментарий → **«Отправить апелляцию»**. Роль **«Проверяющий»** → `#/appeals` → **«Принять решение»** → «Подтвердить оценку» или «Изменить значение» + исход + обоснование → **«Сохранить решение»** → «Итог до → после», история в карточке. Подробно — [docs/APPEALS.md](docs/APPEALS.md).

### Изменить чек-лист, симуляция, версии, замена критерия
`#/checklist`: редактировать/добавить критерий, взять шаблон или **«Заменить»** критерий (сценарий контрольной проверки) → версия-черновик → **«Симуляция на N диалогах»** (без записи) → **«Сохранить и применить к выбранным»**: сохранить версию, активировать, оценить выбранные — модель вызывается только для изменённых критериев (кэш по критерию), в карточке видно «кэш: N критериев, в модель: M». Diff между версиями, восстановление любой, переключатель версий в карточке.

## Архитектура

```mermaid
flowchart LR
  UI["Интерфейс<br/>public/ · vanilla JS"] -- REST JSON --> API["Сервер Node 22<br/>server/ · node:http"]
  API --> Fetch["Загрузка набора<br/>API организаторов / файл"]
  API --> Norm["Нормализация + факты<br/>packages/transcript"]
  Norm --> Route["Маршрутизация по критерию<br/>config/routing.json"]
  Route --> Rule["Правила (детерминированно)<br/>services/evaluator/rules.js"]
  Route --> Judge["Судья (модель)<br/>services/evaluator"]
  Judge --> Val["Валидатор + повтор"] --> Ver["Верификатор<br/>(другая модель, опционально)"]
  Rule --> Score["Движок расчёта<br/>packages/scoring"]
  Ver --> Score --> DB["JSON-хранилище<br/>data/"]
  Judge <--> LLM["alem.plus · локальная модель · heuristic · offline"]
  UI -. "/packages/scoring" .-> Score
```

Один процесс, JSON-файлы, общий движок расчёта в браузере и на сервере, кэш судьи по критерию (ключ — хэш строк диалога, определения критерия, политики, версии промпта и модели), версии чек-листа, симуляция, фоновые задания. Подробно — [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md); схемы данных — [schemas/](schemas/).

## Модели, маршрутизация и стоимость

| Роль | Модель в опубликованном прогоне | Переменная |
|---|---|---|
| Судья | alem.plus · `qwen3-8` | `ALEM_MODEL_JUDGE` |
| Верификатор (другое семейство) | alem.plus · `gpt-oss` — настроен; в продукте вызывается только для результатов с уверенностью < 0.75 (`CQA_VERIFY=low`); в опубликованном прогоне DEV выключен (0 вызовов), его вклад в точность не измерен | `ALEM_MODEL_VERIFIER`, `CQA_VERIFY` |
| Казахское второе мнение | alem.plus · `kazllm` — 15 вызовов (по одному на KZ-диалог); расхождение с судьёй снижает уверенность и отправляет карточку на проверку | `ALEM_MODEL_KZ` |
| Резерв при 429/квоте | alem.plus · AlemLLM — автоматически при остатке ≤ 20 % лимита | `ALEM_MODEL_FALLBACK` |
| Локальная модель | Ollama / любой OpenAI-совместимый сервер — поддерживается конфигурацией; на машине разработки не установлена, качество не измерено | `OPENAI_BASE_URL`, `OPENAI_MODEL` |
| Без модели | `CQA_PROVIDER=heuristic` — правила по всем критериям; `offline` — только сохранённые результаты | `CQA_PROVIDER` |
| Платные облачные (заблокированы) | `CQA_MODEL` / `CQA_VERIFIER_MODEL` | `CQA_ALLOW_CLOUD=1` |

**Гибридная маршрутизация** ([config/routing.json](config/routing.json)): для каждого критерия источник решения выбран по измеренной точности на tune-разбиении (45 диалогов). После исправления валидатора и повторного прогона модель решает **шесть критериев из восьми** (01, 02, 04, 05, 06, 08); **03** и **07** решает детерминированное правило по фактам транскрипта (системное событие подтверждения личности; события завершения), а ответ модели сохраняется как второе мнение. На всех 65 диалогах правило точнее модели на 03 (98.5 % против 95.4 %) и 07 (93.8 % против 92.3 %); ошибка итогового балла (MAE) у гибрида 6.26 против 6.91 у модели одной и 11.36 у правил одних; на отложенной выборке (20 диалогов, на ней ничего не выбиралось) — 4.91 против 5.82 / 14.11 (раздел «Три источника решения» в [reports/calibration.md](reports/calibration.md), методика — [docs/EVALUATION.md](docs/EVALUATION.md)). Маршрутизация действует только пока определение критерия не изменено: новый или отредактированный критерий всегда оценивает модель.

**Стоимость одной оценки: 0 ₸** — бесплатный API alem.plus либо локальная модель. Измерено на опубликованном прогоне DEV (`reports/runs/alem_qwen3-8_v2.json`): **82 вызова на 65 диалогов** (65 судья, 2 повторных запроса после валидатора, 15 казахская модель), 370 с стены при параллелизме 3 (≈ 5.7 с на диалог пропускной способности; 17 с задержка одного диалога), ≈ 6.7 тыс. входных и 2.1 тыс. выходных токенов на диалог. После уточнения подсказки по критерию 06 он переоценён отдельным прогоном (`reports/runs/alem_qwen3-8_v3_c06.json`): ещё 67 вызовов (65 судья + 2 повтора), остальные критерии — из кэша; итого опубликованное состояние стоило 149 живых вызовов и 0 ₸. Ограничение — не деньги, а квота бесплатного API (заголовки показывали 200 запросов на окно неизвестной длины), поэтому кэш по критерию, один вызов судьи на диалог и не более одного повтора. Разбор по ролям и расчёт «если бы это был платный провайдер» (явно помеченная оценка, не факт) — в [docs/COST.md](docs/COST.md). Температура 0; модель, версия промпта и хэш политики записаны в каждом результате.

## Результаты для организаторов

По приложению к гайду организаторов результаты сдаются файлами в формате **JSON 1.0**: один объект на файл, в `results[]` — по одной записи на каждый диалог набора с восемью критериями `contact, discovery, identification, consultation, empathy, dialogue, closure, critical` (`value`: `true`/`false`/`null` = N/A или ступень шкалы; `rationale`; `evidence_turns` — номера реплик с 1 по исходному массиву), `score.final_score` (0–100, два знака) и `score.critical_flag`. Диалог, который не удалось оценить, записывается как `status: "error"` с причиной — не скрывается и не заменяется нулём.

| Файл | Набор | Состояние |
|---|---|---|
| [results/dev/results.json](results/dev/results.json) | DEV — 60 чатов + 5 звонков, 65 записей | в репозитории |
| `results/prod/results.json` | контрольный набор — ровно 10 чатов, выдаётся за час до стоп-кода | создаётся 8 ноября по [docs/CONTROL_DAY.md](docs/CONTROL_DAY.md) |

```bash
npm run export:results -- --group DEV --out results/dev/results.json                 # DEV
npm run export:results -- --group <CONTROL> --out results/prod/results.json --expect 10   # контрольный набор
curl "http://localhost:8080/api/results.json?group_id=DEV"                            # тот же файл из API
```

Экспорт собирает файл из сохранённых оценок активной версии чек-листа и **проверяет** его (схема, восемь критериев ровно по одному разу, уникальные `conversation_id`, число записей при `--expect`); при ошибке проверки файл не считается готовым (код выхода 1). `model.mode = hybrid`, `model.name` перечисляет фактически использованные модели и правила. Код — `server/services/results.js`, `scripts/export-results.mjs`.

## Калибровка

```bash
npm run calibrate      # сравнивает сохранённые оценки с эталонными метками tests/gold/dev_labels.json
```

Эталонные метки **подготовлены командой** (один разметчик, с перечнем допустимых альтернатив для спорных случаев), не организаторами; второго разметчика нет. Отчёт — [reports/calibration.md](reports/calibration.md) (и `reports/calibration.json` для страницы `#/calibration`), методика — [docs/EVALUATION.md](docs/EVALUATION.md). Главные числа текущего отчёта (65 DEV-диалогов, судья `qwen3-8`, чек-лист v1, промпт `judge-v1.0`):

| Что | Значение |
|---|---|
| Точность по бинарным критериям 01 / 02 / 03 / 05 / 07 / 08 | 98.5 % / 95.4 % / 98.5 % / 95.4 % / 93.8 % / 100 % — все шесть выше цели 92 % |
| Шкалы 04 / 06 | 04: точно 87.7 %, в пределах ±1 ступени 96.9 %, κ 0.50; 06: точно 83.1 %, ±1 ступень 98.5 %, κ 0.42 (цели «точно ≥ 70 %, ±1 ≥ 90 %» выполнены; κ умеренная — слабое место, честно показано) |
| Грубые ошибки (08) | полнота 100 % и точность 100 % (8 из 8, ложных флагов нет) |
| Итоговый балл | точное совпадение 55.4 %, в пределах ±5 баллов 63.1 %, средняя абсолютная ошибка 6.26 балла |
| По языкам (все метки) | RU 92.1 % · KZ 96.7 % · EN 95.8 % |

Эталонные метки используются для измерения и для выбора источника решения по критерию в `config/routing.json` (на tune-разбиении; отложенная выборка в отчёте отдельно). В промпты модели метки не попадают; «согласие с человеком» означает согласие с этой разметкой ([docs/LIMITATIONS.md](docs/LIMITATIONS.md)). Что **не** измерено: тест–ретест модели (`--retest N`, повтор измерен только для правил); устойчивость модели к инструкциям внутри транскрипта — есть архитектурная защита (транскрипт в блоке `untrusted`, строгая схема, валидатор, итог считает движок) и тест валидатора на подставном провайдере, но живого теста на модели нет; цикл обучения — реализован (подтверждённые решения проверяющего становятся примерами в промпте), его эффект не измерен (`learning_loop: null`, решений пока нет).

## Тесты и CI

```bash
npm test               # node --test: движок расчёта (вектор 60.5/80 → 75.63, эталонный итог каждого gold-диалога),
                       # нормализация и факты, схемы, сборка D365, аудит репозитория, сервер, оценщик
npm run audit          # scripts/audit-repo.sh — секреты и пути перед push
npm run build:d365     # dist/d365/cqa.html
```

CI (GitHub Actions, Node 22): тесты → аудит → сборка D365. Статус — бейдж вверху.

## Безопасность

Маски персональных данных из источника сохраняются как есть; аудио модели не передаётся; хранилище локальное; транскрипт подаётся модели как недоверенные данные, ответ проверяет детерминированный валидатор (строки существуют, N/A разрешён, ступень в шкале, у «Нет» есть участок); секреты только через `.env`; аудит перед push. Результаты поддерживают коучинг и проверку человеком и не предназначены для автоматических кадровых решений; эмоции не выводятся. Роли «Оператор / Проверяющий» — переключатель интерфейса (авторизация не требуется по условиям задания; для продуктива — роли безопасности Dynamics 365). Подробно — [docs/SECURITY.md](docs/SECURITY.md).

## Dynamics 365

```bash
npm run build:d365     # → dist/d365/cqa.html — один файл, < 5 МБ, относительные пути, хук Xrm
```

Веб-ресурс — только интерфейс: все данные он берёт из REST API по `apiBase` (параметр `data` при открытии или `window.CQA_CONFIG`), поэтому сервер `npm start` должен быть доступен. Таблицы Dataverse (чек-лист, критерий, оценка, результат критерия, апелляция), поток Power Automate для загрузки транскриптов, роли и соотношение с Quality Evaluation Agent — [docs/DYNAMICS365.md](docs/DYNAMICS365.md).

## Ограничения

Честный список — [docs/LIMITATIONS.md](docs/LIMITATIONS.md). Коротко: шкальные критерии 04/06 согласуются с человеком умеренно (κ 0.50 / 0.42 при высокой точности в пределах ступени — парадокс распространённости: большинство эталонов на верхней ступени); эталон — 65 диалогов и один разметчик из команды; верификатор, тест–ретест модели, живой тест на инъекцию и эффект цикла обучения не измерены; дикция/интонация не оцениваются (нужен звук); авторизации нет; хранилище — файлы; решение Dataverse описано, не развёрнуто.

## Документация

| Файл | О чём |
|---|---|
| [docs/SCORING_POLICY.md](docs/SCORING_POLICY.md) | правила по критериям, N/A, формула, пример 75.63 |
| [docs/APPEALS.md](docs/APPEALS.md) | апелляции, статусы, четыре исхода, метрики споров |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | конвейер, модель данных, версии и кэш, симуляция |
| [docs/DYNAMICS365.md](docs/DYNAMICS365.md) | веб-ресурс, Dataverse, Power Automate, роли, QEA |
| [docs/SECURITY.md](docs/SECURITY.md) | данные, модель угроз, правила использования |
| [docs/RESEARCH.md](docs/RESEARCH.md) | аналоги и журнал источников |
| [docs/TOOLING.md](docs/TOOLING.md) | зависимости (их нет) и инструменты |
| [docs/DEMO.md](docs/DEMO.md), [docs/CONTROL_DAY.md](docs/CONTROL_DAY.md) | сценарий демонстрации с точными числами; runbook контрольного дня: 10 чатов → оценка → `results/prod/results.json` → push до стоп-кода |
| [docs/EVALUATION.md](docs/EVALUATION.md) | методика оценки, гибрид правил и модели, что измерено и что нет |
| [docs/COST.md](docs/COST.md), [reports/calibration.md](reports/calibration.md) | измеренная стоимость/задержка; отчёт калибровки |
| [docs/UX.md](docs/UX.md), [CHANGELOG.md](CHANGELOG.md) | дизайн интерфейса; изменения |

## Команда и лицензия

Команда **«Revengers»** — NU Data Challenge «Doomsday», 7–8 ноября 2026, Астана.

| Участник | Роль |
|---|---|
| **Bekassyl Duisek** | капитан команды; спикер на защите — история, бизнес-ценность для Freedom, ответы о продукте |
| **Amirkhan Saribbek** | tech lead — архитектура, оценщик и калибровка; ведёт демонстрацию (драйвер), отвечает на технические вопросы (модель, Dynamics 365, безопасность) |
| **Dias Abdali** | data & QA analyst — данные, контрольный набор и `results.json`; таймкипер, ответы на вопросы по метрикам |

Лицензия [MIT](LICENSE) © 2026 Revengers team.

---

<a id="english"></a>
# English

**Revengers CQA** is a Conversation Quality Analytics prototype built for the NU Data Challenge × Freedom Broker case: automatic, explainable and disputable evaluation of support operators against a configurable checklist, in Russian, Kazakh and English, for chats and voice calls. Repository: <https://github.com/advertising20240-hiii/Revengers-Data-Challenge>.

Every score is an argument you can audit: the checklist rule applied, the evidence lines with verbatim quotes, the checked range for a "No", the reason for an N/A, a confidence value and the decision source (model, deterministic rule or reviewer). Operators can dispute any criterion, an independent reviewer decides with one of four outcomes, the shared scoring engine recomputes the total, and the Calibration page shows how well the model agrees with human labels instead of promising it.

### Features

- **Checklist editor** — criteria with text, section, weight, answer type (Yes/No, Yes/No/N/A, stepped scale, flag-only), N/A availability and condition, criterion- and answer-level guidance for the model; 6 templates (including a deterministic "first reaction time" rule); **versions** (save, activate, diff, restore), **replace criterion**, **simulation** of a draft on N dialogs without touching stored results. New criteria apply through configuration, no code.
- **Evaluation** — fetch a dataset by `group_id` through the organizers' API (server-side, cached), or upload/paste JSON in the same format; evaluate one dialog or all with progress, cancel and resume. Only operator lines are judged; bot and system lines are context.
- **Result** — per criterion: answer, points, weight and effective weight after N/A redistribution, Russian explanation, evidence lines, checked range, N/A reason, rule applied, confidence, source; total, section subtotals, gross-error flag with type (insult / bypass / disclosure) kept separate from the score (DEV dialog `p1-kz-013` scores 92.31 and carries a bypass flag); model, prompt version and latency.
- **Dialog card** — transcript and result side by side, click-to-highlight evidence, audio seek for calls, shareable deep links `#/c/<id>/l/<line>`, checklist-version switcher.
- **Appeals and review** — operator disputes a criterion; the evaluation is marked "under appeal" everywhere and excluded from operator rankings; the reviewer sees the dispute, evidence and fragment, optionally an advisory AI second opinion, and confirms or changes with a reason and one of four outcomes; history is kept.
- **Calibration and insights** — agreement with human labels on the 65 DEV dialogs (accuracy and Cohen's κ per criterion with 95 % CIs, a 20-dialog holdout, confusion matrices, disagreement list with dialog links, gross-error recall/precision); dataset analytics (score distribution, fail rate per criterion, escalation, first-reaction times, hold time, gross-error list, operator cards); CSV export.

### Quick start

```bash
git clone https://github.com/advertising20240-hiii/Revengers-Data-Challenge.git
cd Revengers-Data-Challenge
npm install            # zero dependencies — completes instantly
npm start              # → http://localhost:8080
```

**No key, no network needed**: on first start the server installs checklist v1, loads the bundled DEV dataset (`data/dev/DEV.json`, 65 dialogs) and the 65 committed evaluations (`data/seed/DEV.evaluations.json`). Cards, evidence, appeals, calibration and insights all work; only new evaluations are disabled (an "evaluator unavailable" banner). For live evaluation copy `.env.example` to `.env` and configure a free provider: **alem.plus** (`ALEM_BASE_URL`, `ALEM_API_KEY`, `ALEM_MODEL_*`) or **Ollama** locally (`ollama pull qwen2.5:7b`). Provider selection is automatic (alem → ollama → offline); paid cloud providers are locked behind `CQA_ALLOW_CLOUD=1`.

### Models, routing and cost

Published DEV run: judge `qwen3-8` on alem.plus; Kazakh second opinion `kazllm` (one extra call per KZ dialog; a disagreement lowers confidence and routes the card to review); verifier `gpt-oss` configured — in the product it runs only for results with confidence < 0.75 (`CQA_VERIFY=low`), in the published run it was off and its contribution is unmeasured; fallback AlemLLM (automatic at ≤ 20 % of the quota); a local OpenAI-compatible model (e.g. Ollama) is supported by configuration but was not installed or measured; `CQA_PROVIDER=heuristic` runs every criterion as deterministic rules with no model. **Hybrid routing** ([config/routing.json](config/routing.json)) picks the decision source per criterion from measured tune-split accuracy: after the validator fix and re-run the model decides six of eight criteria (01, 02, 04, 05, 06, 08); 03 and 07 are decided by deterministic transcript facts (the model's answer is kept as a second opinion), where the rule beats the model (03: 98.5 % vs 95.4 %, 07: 93.8 % vs 92.3 % on all 65). Total-score MAE: hybrid 6.26 points vs 6.91 model-only vs 11.36 rules-only; on the untouched 20-dialog holdout 4.91 vs 5.82 / 14.11 ([docs/EVALUATION.md](docs/EVALUATION.md)). Any new or edited criterion is always judged by the model.

**Cost per evaluation: 0 ₸** — free API or local model. Measured on the published DEV run (`reports/runs/alem_qwen3-8_v2.json`): **82 calls for 65 dialogs** (65 judge, 2 validator repairs, 15 Kazakh), 370 s wall at concurrency 3 (≈ 5.7 s per dialog throughput, 17 s mean per-dialog latency), ≈ 6.7k input / 2.1k output tokens per dialog; a follow-up re-evaluation of criterion 06 after its guidance was sharpened (`reports/runs/alem_qwen3-8_v3_c06.json`) took 67 more calls (65 judge + 2 repairs, other criteria from cache) — 149 live calls and 0 ₸ for the published state. The binding constraint is the free API's request quota (headers showed 200 requests per unknown window), not money — hence the per-criterion cache, one judge call per dialog and at most one repair. The explicitly labelled *estimate* of what a paid provider would cost is in [docs/COST.md](docs/COST.md). Temperature 0; model, prompt version and policy hash are recorded on every result.

### Results for the organizers (JSON 1.0)

Per the organizers' appendix, results are submitted as `results/dev/results.json` (DEV, 65 records — committed) and `results/prod/results.json` (the control set, exactly 10 chats, produced on 8 Nov and pushed before the stop code; see [docs/CONTROL_DAY.md](docs/CONTROL_DAY.md)). One record per dialog with the eight fixed criterion ids `contact, discovery, identification, consultation, empathy, dialogue, closure, critical` (`value` true/false/null = N/A or a scale step, `rationale`, `evidence_turns` numbered from 1 over the original transcript), `score.final_score` and `score.critical_flag`; a dialog that could not be evaluated is written as `status: "error"` with a reason, never as a zero. `npm run export:results -- --group <id> --out results/<dev|prod>/results.json [--expect 10]` builds and validates the file (schema, eight criteria exactly once, unique ids, record count); `GET /api/results.json?group_id=<id>` serves the same document.

### Calibration headline numbers

Gold labels were **prepared by the team** (one annotator with accepted alternatives for borderline cases), not by the organizers. From [reports/calibration.md](reports/calibration.md) (65 DEV dialogs): binary criteria 01 / 02 / 03 / 05 / 07 / 08 at 98.5 / 95.4 / 98.5 / 95.4 / 93.8 / 100 % accuracy — all above the 92 % target; scale 04 exact 87.7 %, within one step 96.9 %, κ 0.50; scale 06 exact 83.1 %, within one step 98.5 %, κ 0.42 (targets met; moderate κ is the weak spot, shown honestly); gross-error recall 100 % and precision 100 % (8/8, no false flags); exact total match 55.4 %, within ±5 points 63.1 %, MAE 6.26 points; by language RU 92.1 %, KZ 96.7 %, EN 95.8 %. Not measured: model test–retest (only the rules were re-run), a live prompt-injection test on the model (there is an `untrusted` transcript block, a strict schema, the validator and a validator test with a fake provider), and the effect of the learning loop (implemented — confirmed reviewer decisions become few-shot examples — but no decisions exist yet).

### Scoring

Exactly the organizers' checklist formula: Yes = full weight, No = 0, scale = step / max × weight; N/A criteria are excluded and their weight redistributed; rounded half away from zero to two decimals with exact rational arithmetic (`60.5 / 80 → 75.63`); gross errors are a separate flag that never changes the total. Policy: [docs/SCORING_POLICY.md](docs/SCORING_POLICY.md) (Russian).

### Tests, CI, audit, Dynamics 365

`npm test` (scoring incl. the expected total of every gold dialog, transcript facts, schemas, D365 build, repository audit, server, evaluator) · `npm run audit` (secret and path scan before push) · `npm run build:d365` → `dist/d365/cqa.html`, a single-file HTML web resource under 5 MB with relative paths and an `Xrm` client-URL hook; it is UI only and talks to the REST API at `apiBase`, so the server must be reachable. GitHub Actions runs all three on Node 22. Dataverse table mapping, Power Automate ingestion flow, roles and the relationship to Microsoft's Quality Evaluation Agent (we complement and map to it, not replace it): [docs/DYNAMICS365.md](docs/DYNAMICS365.md).

### Security and usage

PII masks from the source are preserved; no audio is sent to the model; storage is local; transcripts are treated as untrusted data and every answer passes a deterministic validator; secrets only via `.env`. Roles (operator / reviewer) are a UI switch, as the task allows; production needs real authorization. Results support coaching and human review — never automatic employment decisions; no emotion inference. Details: [docs/SECURITY.md](docs/SECURITY.md). Limitations: [docs/LIMITATIONS.md](docs/LIMITATIONS.md).

### Team and license

Team **Revengers**, NU Data Challenge "Doomsday", Astana, 7–8 November 2026.

| Member | Role |
|---|---|
| **Bekassyl Duisek** | team captain, presenter — story, business value for Freedom, product questions |
| **Amirkhan Saribbek** | tech lead — architecture, evaluator and calibration; demo driver, technical Q&A (model, Dynamics 365, security) |
| **Dias Abdali** | data & QA analyst — data, control set and `results.json`; timekeeper, metrics Q&A |

MIT License © 2026 Revengers team.
