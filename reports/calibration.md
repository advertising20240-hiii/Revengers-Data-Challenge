# Калибровка оценщика против экспертных меток (DEV, 65 диалогов)

Дата: 2026-11-07T12:34:05.961Z · провайдер: **alem** · модель-судья: **qwen3-8** · проверяющая модель: нет · версия промпта: judge-v1.0 · чек-лист v1

Разбиение (фиксированное зерно 20261107, стратификация по языку клиента × каналу × исходу «чистый/штраф/грубая ошибка»): tune = 45, holdout = 20. Отчёт построен по разбиению «all». Значение засчитывается, если совпадает с эталоном или входит в список допустимых альтернатив разметчика.

## Точность по критериям (все оценённые диалоги)

| Критерий | Тип | n | Точность | 95% ДИ (Wilson) | ±1 шаг | κ Коэна | 95% ДИ κ (bootstrap) | RU | KZ | EN | Цель |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 01 Установление контакта | да/нет | 65 | 98.5% ✓ | [91.8%; 99.7%] | — | 0.881 | [48.8; 100.0] | 97.1% | 100.0% | 100.0% | ≥ 92% |
| 02 Выявление потребности | да/нет | 65 | 89.2% ✗ | [79.4%; 94.7%] | — | 0.773 | [61.1; 91.2] | 88.6% | 93.3% | 86.7% | ≥ 92% |
| 03 Идентификация | да/нет | 65 | 95.4% ✓ | [87.3%; 98.4%] | — | 0.764 | [50.9; 93.5] | 91.4% | 100.0% | 100.0% | ≥ 92% |
| 04 Корректная и полная консультация | шкала | 65 | 84.6% ✓ | [73.9%; 91.4%] | 95.4% | 0.415 | [18.7; 60.8] | 88.6% | 80.0% | 80.0% | ±1 шаг ≥ 90%, точно ≥ 70% |
| 05 Эмпатия и клиентоориентированность | да/нет | 65 | 96.9% ✓ | [89.5%; 99.2%] | — | 0.625 | [22.8; 89.1] | 97.1% | 93.3% | 100.0% | ≥ 92% |
| 06 Управление диалогом, скорость и грамотность | шкала | 65 | 75.4% ✓ | [63.7%; 84.2%] | 98.5% | 0.234 | [7.0; 39.8] | 77.1% | 80.0% | 66.7% | ±1 шаг ≥ 90%, точно ≥ 70% |
| 07 Завершение | да/нет | 65 | 93.8% ✓ | [85.2%; 97.6%] | — | 0.819 | [67.0; 94.2] | 88.6% | 100.0% | 100.0% | ≥ 92% |
| 08 Грубые ошибки | да/нет | 65 | 98.5% ✓ | [91.8%; 99.7%] | — | 0.932 | [74.5; 100.0] | 97.1% | 100.0% | 100.0% | ≥ 92% |

## Контрольная выборка (holdout)

| Критерий | n | Точность | 95% ДИ | ±1 шаг | κ | 95% ДИ κ | RU | KZ | EN |
|---|---|---|---|---|---|---|---|---|---|
| 01 Установление контакта | 20 | 100.0% | [83.9%; 100.0%] | — | 1 | [100.0; 100.0] | 100.0% | 100.0% | 100.0% |
| 02 Выявление потребности | 20 | 95.0% | [76.4%; 99.1%] | — | 0.864 | [43.7; 100.0] | 100.0% | 80.0% | 100.0% |
| 03 Идентификация | 20 | 100.0% | [83.9%; 100.0%] | — | 1 | [100.0; 100.0] | 100.0% | 100.0% | 100.0% |
| 04 Корректная и полная консультация | 20 | 80.0% | [58.4%; 91.9%] | 95.0% | 0.45 | [9.5; 74.0] | 90.0% | 80.0% | 60.0% |
| 05 Эмпатия и клиентоориентированность | 20 | 95.0% | [76.4%; 99.1%] | — | 0.773 | [0.0; 100.0] | 90.0% | 100.0% | 100.0% |
| 06 Управление диалогом, скорость и грамотность | 20 | 70.0% | [48.1%; 85.5%] | 95.0% | 0.167 | [-17.6; 47.0] | 80.0% | 60.0% | 60.0% |
| 07 Завершение | 20 | 95.0% | [76.4%; 99.1%] | — | 0.913 | [70.6; 100.0] | 90.0% | 100.0% | 100.0% |
| 08 Грубые ошибки | 20 | 100.0% | [83.9%; 100.0%] | — | 1 | [100.0; 100.0] | 100.0% | 100.0% | 100.0% |

## По языкам (все критерии вместе)

| Язык клиента | Диалогов | Меток | Точность | 95% ДИ |
|---|---|---|---|---|
| RU | 35 | 280 | 90.7% | [86.7%; 93.6%] |
| KZ | 15 | 120 | 93.3% | [87.4%; 96.6%] |
| EN | 15 | 120 | 91.7% | [85.3%; 95.4%] |

## Итоговый балл

Балл считается из меток самой модели движком `packages/scoring` (повторный расчёт совпадает всегда: да). Совпадение с эталонным баллом: **52.3%** (n=65); в пределах ±5 баллов: 55.4%; средняя абсолютная ошибка: 6.41 балла. Диалогов, где все семь весовых меток совпали с эталоном: 32.

## Грубые ошибки (критерий 08)

Полнота (recall): 100.0% · точность (precision): 88.9% · TP=8 FP=1 FN=0

| Тип | TP | FP | FN | Recall |
|---|---|---|---|---|
| insult | 1 | 0 | 0 | 100.0% |
| bypass | 4 | 0 | 0 | 100.0% |
| disclosure | 3 | 1 | 0 | 100.0% |

## Воспроизводимость (test–retest)

Повторный прогон не выполнялся (параметр --retest N).

## Устойчивость к инструкциям в транскрипте

Проверка не выполнялась.

## Стоимость и время

0 ₸ — бесплатный API alem.plus (qwen3-8). Измерено: 0 вызовов, 0.3 с всего, ~0 с на диалог (с учётом кэша: 520 попаданий / 0 промахов). Стоимость в USD по прайс-листу: 0 всего, 0 на диалог. Повторных запросов после валидатора: 0; консервативных откатов: 0; расхождений проверяющей модели: 0; расхождений казахской модели: 0.

| Роль | Вызовов | Токены вход | Токены выход | USD |
|---|---|---|---|---|

## Сравнение моделей (все сохранённые прогоны)

| Прогон | Провайдер | Модель | Разбиение | n | 01 | 02 | 03 | 04 | 05 | 06 | 07 | 08 | Балл точно | Gross recall | RU | KZ | EN | с/диалог |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| alem_qwen3-8 | alem | qwen3-8 | all | 65 | 98.5% | 46.2% | 16.9% | 84.6% | 96.9% | 75.4% | 80.0% | 98.5% | 3.1% | 100.0% | 76.4% | 70.8% | 74.2% | 21.8 |
| heuristic_baseline_all | heuristic | heuristic-v1 | all | 65 | 98.5% | 83.1% | 95.4% | 81.5% | 92.3% | 66.2% | 83.1% | 98.5% | 49.2% | 100.0% | 84.6% | 90.0% | 90.8% | 0 |
| hybrid_qwen3-8 | alem | qwen3-8 | all | 65 | 98.5% | 89.2% | 95.4% | 84.6% | 96.9% | 75.4% | 93.8% | 98.5% | 52.3% | 100.0% | 90.7% | 93.3% | 91.7% | 0 |

## Расхождения с эталоном

| Диалог | Критерий | Язык | Модель | Человек | Допустимо | Уверенность | Комментарий разметчика |
|---|---|---|---|---|---|---|---|
| p1-ru-003 | c06 | RU | 10 | 7 | 7/7/4 | 1 | Commission question (#1,#10,#14) never answered; #15 repeats tariff location instead -> 04=10, 06=7 (ignored question), 07=N (farewell while |
| p1-ru-005 | c06 | RU | 7 | 4 | 4 | 0.95 | #12 is garbled ('Там же где перевод, не в отчете, сверху вниз в меню'); client must re-ask (#13) -> 06=4; apology #14 keeps 05=Y; summary+fa |
| p1-ru-006 | c02 | RU | NA | Y | Y | 0.4 | Identity verified (#12) before account action; empathy #10; follow-up channel stated #15. |
| p1-ru-007 | c06 | RU | 10 | 7 | 7/7/4 | 1 | Path given (#11) but explicit question 'when can I retry withdrawal' (#5,#12) dismissed (#13) -> 04=10; 07=N (farewell with open question). |
| p1-ru-009 | c07 | RU | Y | N | N | 0.55 | Account restriction disclosed at #12 with no identification; client objects #13, operator brushes it off #14 -> 03=N, 05=N; reason never exp |
| p1-ru-010 | c06 | RU | 7 | 10 | 10 | 0.9 | Long multi-question chat handled fully; ID before escalation. |
| p1-ru-014 | c06 | RU | 10 | 7 | 7/7/4 | 1 | #10 'Привет, где именно ищете?' — no name, re-asks what client stated in #5 -> 01=N, 02=N; answer correct #12; 'Хорошего дня.' has no summar |
| p1-ru-015 | c07 | RU | N | Y | Y | 0.55 |  |
| p1-ru-016 | c02 | RU | NA | N | N | 0.4 | Instruction without asking where the client is (#10), second guess #12, correct only at #14 -> 02=N, 04=15, 06=4. |
| p1-ru-016 | c04 | RU | 20 | 15 | 15/15/10 | 1 | Instruction without asking where the client is (#10), second guess #12, correct only at #14 -> 02=N, 04=15, 06=4. |
| p1-ru-016 | c06 | RU | 7 | 4 | 4 | 0.9 | Instruction without asking where the client is (#10), second guess #12, correct only at #14 -> 02=N, 04=15, 06=4. |
| p1-ru-016 | c07 | RU | N | Y | Y | 0.8 | Instruction without asking where the client is (#10), second guess #12, correct only at #14 -> 02=N, 04=15, 06=4. |
| p1-ru-018 | c02 | RU | NA | N | N | 0.4 | Confident unfounded claim (#10) then 'Тогда не знаю' (#12), chat closed on client (#13): 04=0, 05=N, 06=0 (contradictory), 07=N. |
| p1-ru-018 | c06 | RU | 7 | 0 | 0/0/4 | 0.9 | Confident unfounded claim (#10) then 'Тогда не знаю' (#12), chat closed on client (#13): 04=0, 05=N, 06=0 (contradictory), 07=N. |
| p1-ru-025 | c04 | RU | 20 | NA | NA | 0.95 | Client left before stating a request (#11): 04 N/A (exact checklist condition), 07 N/A (chat broke off), 03 N/A. Demo example for N/A. |
| p1-ru-026 | c05 | RU | Y | N | N | 1 | 'Чем могу помочь?' ignores stated request; 'Всё есть в приложении' is no answer; chat closed on client. |
| p1-ru-026 | c06 | RU | 10 | 4 | 4/4/0 | 0.9 | 'Чем могу помочь?' ignores stated request; 'Всё есть в приложении' is no answer; chat closed on client. |
| p1-kz-003 | c02 | KZ | NA | Y | Y | 0.4 | ID (#13) before case escalation; empathy #11. |
| p1-kz-003 | c06 | KZ | 7 | 10 | 10 | 0.9 | ID (#13) before case escalation; empathy #11. |
| p1-kz-005 | c06 | KZ | 7 | 4 | 4 | 1 | Vague 'Профильге кіріңіз' (#10) -> client re-asks (#11) -> exact path (#12); 'Жақсы.' is no farewell -> 07=N. |
| p1-kz-012 | c04 | KZ | 10 | 20 | 20 | 0.7 | Correct next step given even though client postponed. |
| p1-kz-013 | c04 | KZ | 10 | 20 | 20 | 0.7 | GROSS: paid private advice for personal number (#12); operator closed chat without farewell (#14). |
| p1-kz-015 | c04 | KZ | 10 | 5 | 5/5/0 | 0.7 | Mirror of p1-ru-009: restriction disclosed (#10) without ID, client objects (#11), dismissed (#12). |
| p1-kz-015 | c05 | KZ | Y | N | N | 1 | Mirror of p1-ru-009: restriction disclosed (#10) without ID, client objects (#11), dismissed (#12). |
| p1-kz-015 | c06 | KZ | 10 | 4 | 4/4/7 | 1 | Mirror of p1-ru-009: restriction disclosed (#10) without ID, client objects (#11), dismissed (#12). |
| p1-en-005 | c06 | EN | 7 | 10 | 10 | 1 |  |
| p1-en-006 | c02 | EN | NA | Y | Y | 0.4 |  |
| p1-en-006 | c06 | EN | 7 | 10 | 10 | 0.9 |  |
| p1-en-007 | c06 | EN | 10 | 7 | 7/7/4 | 1 | Mirror of p1-ru-007: retry question (#5,#11) ignored at #12. |
| p1-en-008 | c04 | EN | 15 | 20 | 20 | 0.9 |  |
| p1-en-008 | c06 | EN | 7 | 10 | 10 | 0.8 |  |
| p1-en-013 | c04 | EN | 15 | 20 | 20 | 0.8 | GROSS: paid private advice (#12); agent closed chat (#14). |
| p1-en-014 | c04 | EN | 10 | 5 | 5/5/0 | 0.9 | Restriction disclosed (#11) with no ID; 'We can skip that' (#13); 'Will I hear back here?' (#14) unanswered; 'Goodbye.' only. |
| p1-en-015 | c02 | EN | NA | N | N | 0.4 | No greeting/name (#10), blind instruction, correct only at #12, 'Bye.' only. |
| p1-en-015 | c06 | EN | 7 | 4 | 4 | 0.9 | No greeting/name (#10), blind instruction, correct only at #12, 'Bye.' only. |
| p4-ru-003 | c03 | RU | N | Y | Y | 0.8 | Masked name ([Имя скрыто]) counts as introduction. ID via FIO+IIN+SMS (#40-65) before order status (#66). Initial misunderstanding (#27) ->  |
| p4-ru-003 | c08 | RU | Y | N | N | 0.95 | Masked name ([Имя скрыто]) counts as introduction. ID via FIO+IIN+SMS (#40-65) before order status (#66). Initial misunderstanding (#27) ->  |
| p4-ru-002 | c01 | RU | N | Y | Y | 0.95 | Callback. ID (#12-15) before consult/transfer. Lines #20-58 are operator<->trader consultation while client on hold (context, not client-fac |
| p4-ru-002 | c02 | RU | NA | Y | Y | 0.4 | Callback. ID (#12-15) before consult/transfer. Lines #20-58 are operator<->trader consultation while client on hold (context, not client-fac |
| p4-ru-002 | c03 | RU | NA | Y | Y | 0.55 | Callback. ID (#12-15) before consult/transfer. Lines #20-58 are operator<->trader consultation while client on hold (context, not client-fac |
| p4-ru-001 | c04 | RU | 20 | 15 | 15/15/10 | 0.95 | General question about what support does; correct boundaries explained (#26-31) but no concrete next step (how to get advice) -> 04=15. Clie |
| p4-ru-005 | c04 | RU | 15 | 20 | 20 | 0.85 | #17 'Компания fernetbark и операции Здравствуйте' — no recognizable name (ASR-garbled) -> 01=N (YES acceptable if judged as ASR artifact). A |
| p4-ru-005 | c07 | RU | NA | Y | Y | 0.55 | #17 'Компания fernetbark и операции Здравствуйте' — no recognizable name (ASR-garbled) -> 01=N (YES acceptable if judged as ASR artifact). A |
| p4-ru-004 | c03 | RU | NA | Y | Y | 0.55 | ID via address+SMS (#38-79) before order info (#90). OTC-only answer + email/phone alternative -> 04=15 (client's 'can't call each time' onl |

## Честные замечания

- Ниже цели: 02 (89.2%). Причины — в таблице расхождений: в основном смысловые критерии, где нужна оценка полноты ответа и реакции на недовольство.
- κ Коэна занижен для критериев с сильно несбалансированными метками (например 01 и 08, где почти все эталоны одинаковы): высокая точность при низком κ — артефакт распределения, а не слабая согласованность.
- Эталонные метки используются только в этом скрипте; в промпты и логику продукта они не попадают.

## Summary (EN)

Provider alem, judge model qwen3-8, 65 DEV dialogs (all split; tune 45 / holdout 20, stratified, seed 20261107). Per-criterion accuracy vs. accepted human labels: 01 98.5%, 02 89.2%, 03 95.4%, 04 84.6%, 05 96.9%, 06 75.4%, 07 93.8%, 08 98.5%. Exact total match 52.3%, MAE 6.41 pts. Gross-error recall 100.0%, precision 88.9%. By language: RU 90.7%, KZ 93.3%, EN 91.7%. Cost: 0 ₸ — бесплатный API alem.plus (qwen3-8); 0 s per dialog measured. Gold labels are used for measurement only.
