---
name: ktx-booking
description: Read-only KTX operating-timetable lookup from official Korail public XLSX attachments. No login, internal mobile API, anti-bot bypass, live seat availability, reservation, or payment.
license: MIT
---

> Adapted from [NomaDamas/k-skill](https://github.com/NomaDamas/k-skill) (MIT License,
> Copyright (c) 2026 the k-skill contributors — see `skills/THIRD_PARTY_NOTICES.md`).
> Source: https://github.com/NomaDamas/k-skill/blob/main/ktx-booking/instruction.md

# KTX Official Timetable Lookup

## What this skill does

한국철도공사가 로그인 없이 공개하는 최신 KTX 운행시간표 XLSX를 내려받아 출발역·도착역·출발시간 조건에 맞는 열차를 찾는다.

이 스킬은 **공식 계획 시간표 조회 전용**이다.

- 회원 로그인, credential, Korail 앱 내부 API를 사용하지 않는다.
- Dynapath 또는 anti-bot token을 생성·재현·우회하지 않는다.
- 실시간 잔여석, 실제 운휴·지연, 호차·좌석번호는 조회하지 않는다.
- 예약, 예약대기, 좌석 선점, 결제, 취소, 자동 재조회는 실행하지 않는다.
- 구매와 실시간 운행 확인은 공식 코레일 페이지에서 사용자가 직접 진행한다.

실행 환경에는 Python 3.11 이상과 `uv`가 필요하다. `uv`가 helper에 고정된 `openpyxl` 환경을 자동 설치한다.

## Commands

```bash
npx -y @nomadamas/k-skill@0 exec ktx-booking scripts/ktx_booking.py -- \
  search --dep 서울 --arr 부산 --date 20260819 --time 0600 --time-limit 1200 --limit 5
```

```bash
npx -y @nomadamas/k-skill@0 exec ktx-booking scripts/ktx_booking.py -- source
```

## Inputs

- `--dep`: 출발역명. `서울`과 `서울역` 모두 허용한다.
- `--arr`: 도착역명.
- `--date`: `YYYYMMDD`.
- `--time`: 가장 이른 출발시각 `HHMM`, 기본 `0000`.
- `--time-limit`: 가장 늦은 출발시각 `HHMM`, 기본 `2359`.
- `--limit`: 최대 결과 수, 1~50.

## Output

- `count`
- `trains[]`: `train_no`, `train_type`, `dep`, `arr`, `dep_time`, `arr_time`
- `date`
- `schedule_note`
- `source`: 공식 게시물 제목·게시일·XLSX URL·게시판 URL
- `booking_url`

항상 이 결과는 **공개 운행계획 시간표**이며 실시간 잔여석·운휴·지연 정보가 아니라는 점을 명시한다.

## Failure modes

- 공식 시간표 게시판 또는 XLSX 다운로드 실패
- 요청일에 적용되는 KTX 시간표 없음
- XLSX 형식 변경으로 header를 찾지 못함
- 요청 구간·시간대 결과 없음: 오류가 아니라 `count: 0`
- 잘못된 날짜·시간·limit: 실행 전 오류

## Hard boundaries

- 로그인·credential 요청 금지
- `ScheduleView`, `korail2`, Dynapath 등 앱 내부 경로 사용 금지
- 예약·결제·취소·좌석 선점 금지
- CAPTCHA·인증·anti-bot 통제 우회 금지
