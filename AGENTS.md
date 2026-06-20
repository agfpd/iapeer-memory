# iapeer-memory — инструкция для рабочей сессии

Память пира для экосистемы iapeer. Монорепо: `core/` (host-neutral
TS-примитив: taxonomy / поиск / memoryd / рендеры) + `package/` (npm-фасад —
**пакет И ЕСТЬ система**; сессионные поверхности — прямыми файлами в cwd
пиров). Обзор продукта — `docs/README.md`.

Репозиторий активно разрабатывается: `git pull` перед каждым куском работы.

## Команды

- `bun install` · `bun test` (root: core+package) · `bun run typecheck`.
- Тесты идут под предохранителем `IAPEER_MEMORY_SUPPRESS_IAP_SEND=1`
  (bunfig `[test].preload` в root И в `package/` — сырой `bun test` из обоих
  cwd накрыт): тест никогда не дотягивается до живого notifier, потому что
  сокеты notifier host-глобальны и песочный `IAPEER_ROOT` реальный send
  НЕ сдерживает. Тесту, которому нужен spawn-путь, нужны fake-bin + локальное
  снятие env (образец: `package/tests/watcher.test.ts`).

## Релиз — два пакета, один номер версии

Публикуются два пакета одной версией: `@agfpd/iapeer-memory-core` +
`@agfpd/iapeer-memory`. Зависимость фасада на core — **точный пин версии**,
не `workspace:*`: `npm publish` отдаёт манифест в registry дословно и
workspace-протокол не переписывает (переписывают только bun/pnpm publish).
Локальная разработка не страдает — bun резолвит workspace-пакет по совпадению
semver. Lockstep держит `package/src/sync-versions.ts` (core/package.json +
dep-пин).

Релиз: `cd package && npm run release` (patch; есть `:minor` / `:major`). Два
workspace-специфичных отличия осознанны:

1. **Явные commit+tag в `release:finish`** — `npm version` создаёт git-коммит
   и тег только когда package.json лежит в корне git-репо; в workspace-поддире
   он молча пропускает git-операции. Тег делай annotated (`tag -a`):
   `git push --follow-tags` пушит только annotated.
2. **`--workspaces-update=false`** — дефолтный post-bump install npm падает на
   bun-layout `node_modules`; install'ами в этом репо владеет bun, npm — только
   version / publish.

Остальное стандартно: `prepublishOnly` = чистое дерево, commit-message = номер
версии.

## Песочницы и e2e

- Изоляция хоста: `IAPEER_ROOT` + `IAPEER_MEMORY_{CONFIG_FILE,STATE_DIR,
  CACHE_DIR,LOGS_DIR,BINARY_PATH}`. Путь БД следует лестнице
  `DB_PATH → CACHE_DIR/index.db → IAPEER_ROOT/cache/… → ~/.iapeer/…` в ДВУХ
  местах — `package/src/paths.ts` и `core/src/config.ts`; меняй синхронно
  (их рассинхрон однажды протёк SQLite-записью песочницы в прод-кэш).
- Смоук-тесты — только на throwaway-пирах / tmp, никогда против реального
  vault.

## Стыки экосистемы (проверенные факты, не память модели)

- `iapeer send --from` принимает **identity** `<runtime>-<personality>`
  (`claude-index`), голая personality отбивается CLI. Owner durable-триггера —
  personality. Unregister шли от identity регистранта триггера.
- Watcher-контракт notifier (registrant / durable-файл / без heartbeatSec) —
  в шапке `package/src/watcher.ts`.
- MCP memoryd — порт 8766 (8765 занят iapeer-MCP).
- Сверяй числа и форматы по коду, не по прозе: проза дрейфует от кода.
- Класс «контракт документирован, но НЕ реализован»: док или шапка модуля
  может обещать поведение, которого код не подключает (например «renders
  continuously» без единого вызова рендера). Адверсариальная вычитка ловит
  противоречия, но не пустые обещания: grep заявлений
  «renders / continuously / automatically / рендерит» по `docs/` → для каждого
  найди ФАКТИЧЕСКИЙ вызов в коде. Нет вызова → дефект, не стилистика.
