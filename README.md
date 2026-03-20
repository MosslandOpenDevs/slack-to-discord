# slack2discord

A bridge service that forwards Slack channel messages to Discord in real time via webhook.

- Uses Slack **Socket Mode** — no public server URL required
- Customizable message transform hook (`transform.ts`)
- Bot message allowlist support
- Slack Block Kit → Discord markdown conversion
- Runs as a systemd service for always-on background operation

## Requirements

- Node.js 18+
- Ubuntu server (systemd)

## Installation

```bash
npm install
npm run build
cp src/transform.example.ts src/transform.ts
cp .env.example .env
```

## Configuration

Edit `.env` with your credentials:

| Variable | Required | Description |
|----------|----------|-------------|
| `SLACK_APP_TOKEN` | ✅ | App-Level Token starting with `xapp-` |
| `SLACK_BOT_TOKEN` | ✅ | Bot Token starting with `xoxb-` |
| `DISCORD_WEBHOOK_URL` | ✅ | Discord channel webhook URL |
| `SLACK_CHANNEL_ALLOWLIST` | - | Channel IDs to forward (comma-separated, empty = all channels) |
| `SLACK_BOT_ALLOWLIST` | - | Bot IDs to allow (comma-separated, empty = block all bots) |
| `DISCORD_USERNAME` | - | Fixed display name in Discord (empty = use Slack sender name) |
| `DEBUG_LOG_CONTENT` | - | Set to `true` to log message content to stdout (disabled by default) |

## Slack App Setup

1. Create an app at [api.slack.com/apps](https://api.slack.com/apps)
2. Enable **Socket Mode** → Basic Information > Socket Mode toggle ON
3. Create an **App-Level Token** → Basic Information > App-Level Tokens > `connections:write` scope → copy `xapp-...`
4. Enable **Event Subscriptions** → subscribe to `message.channels`
5. Add **Bot Token Scopes** → `channels:history`, `channels:read`, `users:read`
6. Install the app to your workspace → copy `xoxb-...`
7. Invite the bot to the target channel: `/invite @botname`

## Customizing the Transform

`src/transform.ts` controls how Slack messages appear in Discord. It is **gitignored** so your customizations stay local.

```typescript
// src/transform.ts
export function transform(ctx: TransformContext): DiscordPayload | null {
  // Return a DiscordPayload to forward, or null to drop the message.
  return ctx.payload; // default: forward as-is
}
```

Available context:

| Property | Description |
|----------|-------------|
| `ctx.event` | Raw Slack message event (text, blocks, attachments, files, ...) |
| `ctx.channelName` | Resolved Slack channel name (e.g. `general`) |
| `ctx.userName` | Resolved sender display name |
| `ctx.text` | Slack mrkdwn converted to Discord markdown |
| `ctx.payload` | Default Discord payload built by the bridge |

See [`examples/`](examples/) for real-world use cases.

## Testing the Transform Offline

Fetch today's messages from Slack, run them through `transform.ts`, and write results to `test.log` — nothing is sent to Discord.

```bash
npm run build
node dist/test.js          # today's messages
node dist/test.js 20       # last 20 messages
```

## Usage

### Direct (for testing)

```bash
npm start
```

### systemd service (production)

Edit `slack2discord.service` to match your `User` and `WorkingDirectory`, then:

```bash
sudo cp slack2discord.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable slack2discord
sudo systemctl start slack2discord
```

### Service management

```bash
# Check status
sudo systemctl status slack2discord

# Live logs
journalctl -u slack2discord -f

# Restart after rebuilding
npm run build && sudo systemctl restart slack2discord

# Stop
sudo systemctl stop slack2discord
```

## Behavior

| Situation | Behavior |
|-----------|----------|
| Bot message | Blocked unless bot ID is in `SLACK_BOT_ALLOWLIST` |
| `message_changed` / `message_deleted` / `channel_join` | Ignored |
| Slack `*bold*` → Discord `**bold**` | Auto-converted |
| Slack `~strikethrough~` → Discord `~~strikethrough~~` | Auto-converted |
| Channel mention `<#C...\|name>` | Converted to `#name` |
| URL `<https://...\|text>` | Converted to `[text](url)` |
| Slack Block Kit | Converted to Discord markdown |
| Slack attachment | Converted to Discord embed |
| File attachment | Displayed as link |
| `transform()` returns `null` | Message silently dropped |
| Error | Logged, service keeps running |
| Server reboot | Auto-restart via systemd `Restart=on-failure` |

## Finding a Bot ID

To allow a specific bot, you need its ID (starts with `B`). Check the logs:

```bash
journalctl -u slack2discord | grep "bot_id"
```

## Project Structure

```
src/
  index.ts            # Main bridge (Socket Mode listener)
  transform.ts        # Custom transform hook — gitignored, edit freely
  transform.example.ts# Default passthrough template
  blockkit.ts         # Slack Block Kit → Discord markdown parser
  convert.ts          # Slack mrkdwn → Discord markdown converter
  types.ts            # Shared TypeScript interfaces
  test.ts             # Offline transform tester
examples/
  transform.attendance.ts  # Attendance bot message formatting example
```

---

# slack2discord (한국어)

Slack 채널 메시지를 Discord 웹훅으로 실시간 포워딩하는 브릿지 서비스.

- Slack **Socket Mode** 사용 — 공개 서버 URL 불필요
- 커스터마이징 가능한 메시지 변환 훅 (`transform.ts`)
- 봇 메시지 allowlist 지원
- Slack Block Kit → Discord 마크다운 변환
- systemd 서비스로 백그라운드 상시 실행

## 요구 사항

- Node.js 18+
- Ubuntu 서버 (systemd)

## 설치

```bash
npm install
npm run build
cp src/transform.example.ts src/transform.ts
cp .env.example .env
```

## 환경변수 설정

`.env` 파일을 편집하세요:

| 변수 | 필수 | 설명 |
|------|------|------|
| `SLACK_APP_TOKEN` | ✅ | `xapp-` 로 시작하는 App-Level Token |
| `SLACK_BOT_TOKEN` | ✅ | `xoxb-` 로 시작하는 Bot Token |
| `DISCORD_WEBHOOK_URL` | ✅ | Discord 채널 웹훅 URL |
| `SLACK_CHANNEL_ALLOWLIST` | - | 포워딩할 채널 ID (콤마 구분, 비우면 전체 채널) |
| `SLACK_BOT_ALLOWLIST` | - | 허용할 봇 ID (콤마 구분, 비우면 모든 봇 차단) |
| `DISCORD_USERNAME` | - | Discord에 표시될 이름 고정 (비우면 Slack 발신자 이름) |
| `DEBUG_LOG_CONTENT` | - | `true` 설정 시 메시지 내용을 stdout에 로깅 (기본 비활성) |

## Slack 앱 설정

1. [api.slack.com/apps](https://api.slack.com/apps) 에서 앱 생성
2. **Socket Mode** 활성화 → Basic Information > Socket Mode 토글 ON
3. **App-Level Token** 발급 → Basic Information > App-Level Tokens > `connections:write` 권한 → `xapp-...` 복사
4. **Event Subscriptions** 활성화 → `message.channels` 구독 추가
5. **Bot Token Scopes** → `channels:history`, `channels:read`, `users:read` 추가
6. 워크스페이스에 앱 설치 → `xoxb-...` 복사
7. 봇을 포워딩할 채널에 `/invite @봇이름` 으로 초대

## 메시지 변환 커스터마이징

`src/transform.ts`에서 Slack 메시지가 Discord에 표시되는 방식을 제어합니다. 이 파일은 **gitignore**에 등록되어 있어 로컬 설정이 보호됩니다.

```typescript
// src/transform.ts
export function transform(ctx: TransformContext): DiscordPayload | null {
  // DiscordPayload를 반환하면 전송, null을 반환하면 드롭
  return ctx.payload; // 기본: 그대로 전달
}
```

사용 가능한 context:

| 속성 | 설명 |
|------|------|
| `ctx.event` | Slack 메시지 이벤트 원본 (text, blocks, attachments, files, ...) |
| `ctx.channelName` | Slack 채널 이름 (예: `general`) |
| `ctx.userName` | 발신자 표시 이름 |
| `ctx.text` | Slack mrkdwn → Discord 마크다운 변환된 텍스트 |
| `ctx.payload` | 브릿지가 기본으로 생성한 Discord payload |

실제 사용 예시는 [`examples/`](examples/) 폴더를 참고하세요.

## 오프라인 변환 테스트

오늘의 Slack 메시지를 가져와 `transform.ts`를 통해 실행하고 결과를 `test.log`에 저장합니다. Discord로는 전송하지 않습니다.

```bash
npm run build
node dist/test.js          # 오늘 메시지 전체
node dist/test.js 20       # 최근 20개
```

## 실행

### 직접 실행 (테스트용)

```bash
npm start
```

### systemd 서비스 등록 (운영)

`slack2discord.service` 파일의 `User`, `WorkingDirectory` 경로를 실제 환경에 맞게 수정 후:

```bash
sudo cp slack2discord.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable slack2discord
sudo systemctl start slack2discord
```

### 서비스 관리

```bash
# 상태 확인
sudo systemctl status slack2discord

# 로그 실시간 확인
journalctl -u slack2discord -f

# 빌드 후 재시작
npm run build && sudo systemctl restart slack2discord

# 중지
sudo systemctl stop slack2discord
```

## 동작 방식

| 상황 | 처리 |
|------|------|
| 봇 메시지 | `SLACK_BOT_ALLOWLIST`에 없으면 차단 |
| `message_changed` / `message_deleted` / `channel_join` | 무시 |
| Slack `*굵게*` → Discord `**굵게**` | 자동 변환 |
| Slack `~취소선~` → Discord `~~취소선~~` | 자동 변환 |
| 채널 멘션 `<#C...\|name>` | `#name` 으로 변환 |
| URL `<https://...\|텍스트>` | `[텍스트](url)` 로 변환 |
| Slack Block Kit | Discord 마크다운으로 변환 |
| Slack attachment | Discord embed 로 변환 |
| 파일 첨부 | 링크로 표시 |
| `transform()` 가 `null` 반환 | 메시지 드롭 |
| 오류 발생 | 로그 기록, 서비스 유지 |
| 서버 재부팅 | systemd `Restart=on-failure` 로 자동 재시작 |

## 봇 ID 확인 방법

봇 메시지를 허용하려면 해당 봇의 ID(`B`로 시작)가 필요합니다:

```bash
journalctl -u slack2discord | grep "bot_id"
```

## 프로젝트 구조

```
src/
  index.ts            # 메인 브릿지 (Socket Mode 리스너)
  transform.ts        # 커스텀 변환 훅 — gitignore 처리, 자유롭게 편집
  transform.example.ts# 기본 passthrough 템플릿
  blockkit.ts         # Slack Block Kit → Discord 마크다운 파서
  convert.ts          # Slack mrkdwn → Discord 마크다운 변환기
  types.ts            # 공유 TypeScript 인터페이스
  test.ts             # 오프라인 변환 테스터
examples/
  transform.attendance.ts  # 근태봇 메시지 포맷 예시
```
