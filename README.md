# admin-manager

> 포트폴리오 공개용 스냅샷입니다. 실제 IP·도메인·조직명은 예시값(`10.0.0.x`, `example.ac.kr`, `myorg`)으로 바꿨고 비밀값은 포함하지 않습니다. 전체 소개는 [k8s-manager](https://github.com/milk024/k8s-manager) 를 보세요.

> 쿠버네티스 클러스터의 **고권한 관리 작업만 전담하도록 분리한** 관리자 백엔드 서버
> 관리자 인증 · 네임스페이스 YAML 관리 · 개발자 계정(kubeconfig) 발급/회수

![Node.js](https://img.shields.io/badge/Node.js-22-339933?logo=node.js&logoColor=white)
![Express](https://img.shields.io/badge/Express-5-000000?logo=express&logoColor=white)
![Kubernetes](https://img.shields.io/badge/Kubernetes-client--node%201.4-326CE5?logo=kubernetes&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-pg-4169E1?logo=postgresql&logoColor=white)
![Docker](https://img.shields.io/badge/Docker-node%3A22.16--slim-2496ED?logo=docker&logoColor=white)

---

## 📌 프로젝트 개요

사내 쿠버네티스 클러스터를 웹으로 모니터링하는 `k8s_manager`(조회 위주 서버)를 운영하던 중,
**리소스 수정 · 계정 발급 같은 고권한 기능**이 필요해졌습니다.
이 기능들을 기존 서버에 추가하면 조회용 서버까지 강한 권한을 갖게 되므로,
**권한 격리(Privilege Separation)** 원칙에 따라 고권한 작업만 담당하는 별도 서버로 분리했습니다.

| 구분 | k8s_manager | **admin-manager (이 저장소)** |
|---|---|---|
| 역할 | 클러스터 상태 조회 / 모니터링 | 리소스 변경, 개발자 계정 발급 |
| K8s 권한 | 읽기 위주 | 화이트리스트 Kind 쓰기 + RBAC 발급 |
| 인증 | — | 관리자 JWT 필수 |
| DB | 별도 | 같은 Postgres 인스턴스, **DB·계정 완전 분리** |

## ✨ 주요 기능

### 1. 관리자 인증 (JWT)
- `bcrypt`(salt rounds 12)로 비밀번호 해싱, 로그인 시 JWT 발급
- 무상태(Stateless) `Authorization: Bearer` 방식, 세션·쿠키 미사용
- **최초 관리자 부트스트랩**: `admin_users` 테이블이 비어 있을 때만 환경변수로 1회 생성,
  이후 관리자 추가는 인증된 관리자만 가능

### 2. 네임스페이스 YAML 관리 ("웹에서 kubectl apply")
- 리소스 조회 / 생성·수정(upsert) / 삭제
- **Kind 화이트리스트**: `Deployment`, `Service`, `ConfigMap`, `PersistentVolumeClaim`,
  `NetworkPolicy`, `HTTPRoute`만 허용해 blast radius를 제한
- **Secret은 영구 제외**: 값은 절대 읽거나 쓰지 않고, Pod가 참조하는 Secret의 *이름*만 노출
- **낙관적 동시성 제어**: `resourceVersion`을 비교해 다른 관리자의 변경을 조용히 덮어쓰지 않음
- 편집용 조회 시 `status`, `managedFields`, `uid` 등 서버 전용 필드를 제거해서 반환
- **Pod 기준 연관 리소스 탐색**: Pod → ReplicaSet → Deployment 소유 관계를 따라가고,
  마운트된 ConfigMap / PVC / Secret(이름만)을 묶어서 반환
- 모든 변경은 `manifest_history`에 **감사 로그**로 기록 (누가 · 언제 · 무엇을)

### 3. 개발자 계정(kubeconfig) 발급
- ServiceAccount + Role + RoleBinding을 생성하고, **TokenRequest API**로 만료되는 토큰을 발급해
  바로 쓸 수 있는 kubeconfig 파일로 반환
- 권한은 자유 입력이 아니라 **고정 RBAC 템플릿**(`readonly`, `namespace-write`) 중에서만 선택
  → K8s RBAC의 privilege-escalation 방지 규칙과 충돌하지 않고,
  admin-manager 자체 ClusterRole도 "템플릿들의 합집합"으로 최소한만 유지
- 발급/회수 이력을 `account_issuances`에 기록 (발급자 `issued_by`, 회수자 `revoked_by`)

### 4. Gitea 사용자·팀 관리
- 사용자 목록(팀·상태·마지막 로그인), 생성(임시 비밀번호 + 첫 로그인 때 변경 강제, 팀 지정), 로그인 차단/허용, 비밀번호 초기화, 팀 구성원 추가/제거
- site admin 계정 `gitea-mgmt-svc` 토큰(`GITEA_MGMT_TOKEN`)으로 Gitea API 호출
- 보호: site admin 과 보호 팀(`GITEA_PROTECTED_TEAMS`, 기본 `Owners,ci-*,svc-*`) 구성원은 어떤 변경도 거부, 보호 팀 구성원 추가/제거도 거부. 매 요청마다 Gitea 현재 상태로 판정
- 사용자 삭제, 팀·저장소 생성/삭제, 팀 권한 변경은 하지 않음 (Gitea 화면에서 gitea_admin 으로)
- 임시 비밀번호는 응답으로 한 번만 돌려주고 저장·로그·이력에 남기지 않음
- 웹: monitoring-web `/admin` → **Gitea 사용자** 탭

### 5. 관리 작업 이력 (감사 로그)
- 로그인(성공/실패/잠김), 계정 발급·회수, YAML 적용·삭제, 관리자 추가, Gitea 관리(`gitea.*`)를 성공·실패 모두 `audit_log`에 기록
- 누가(`actor`) · 어디서(`ip`) · 무엇을(`action`) · 어디에(`target`) · 결과(`result`) · 부가 정보(`detail`, 비밀값 제외)
- 기록 실패는 본 작업을 막지 않는다 (경고 로그만)
- `audit_log`가 생기기 전 기록은 첫 기동 때 한 번 이관된다 (`detail.migrated = true`)
- 웹: monitoring-web `/admin` → **작업 이력** 탭

## 🏗 아키텍처

```
          monitoring-web (프론트엔드)
            │                    │
            ▼                    ▼
     ┌─────────────┐     ┌──────────────────┐
     │ k8s_manager │     │  admin-manager   │  ← JWT 인증 필수
     │  (조회 전용)  │     │   (고권한 전용)    │
     └──────┬──────┘     └───┬──────────┬───┘
            │                │          │
            ▼                ▼          ▼
     ┌──────────────────────────┐  ┌──────────────────────┐
     │   Kubernetes API Server  │  │ PostgreSQL           │
     │ (in-cluster SA 인증)      │  │ admin_manager DB(분리) │
     └──────────────────────────┘  └──────────────────────┘
```

### 디렉터리 구조

```
admin_manager/
├── main.cjs                     # 엔트리포인트: 시작 체크 후 HTTP 서버 기동
├── core/
│   ├── app.cjs                  # Express 앱 (CORS, 라우터, 에러 핸들러)
│   ├── controller.cjs           # 기동 시 DB 스키마 초기화 + 관리자 부트스트랩 + 헬스체크
│   └── routers/
│       ├── authRouter.cjs       # /api/auth
│       ├── accountRouter.cjs    # /api/accounts
│       ├── manifestRouter.cjs   # /api/manifests
│       ├── auditRouter.cjs      # /api/audit
│       └── giteaAdminRouter.cjs # /api/gitea
├── services/
│   ├── authService.cjs          # 로그인, 관리자 생성, 부트스트랩
│   ├── dbService.cjs            # pg Pool + 스키마 초기화
│   └── k8sAdminService.cjs      # K8s API 연동 (계정 발급, 매니페스트 관리)
├── helpers/
│   ├── authMiddlewareHelper.cjs # requireAdmin() 미들웨어
│   ├── jwtHelper.cjs / passwordHelper.cjs
│   ├── manifestWhitelistHelper.cjs  # 허용 Kind ↔ apiVersion 매핑
│   ├── rbacTemplateHelper.cjs       # 발급 가능한 RBAC 템플릿 정의
│   ├── configHelper.cjs / logHelper.cjs
└── Dockerfile
```

계층 구조: **Router**(요청 검증) → **Service**(비즈니스 로직 · 외부 연동) → **Helper**(정책 · 유틸).
보안 정책(허용 Kind, RBAC 템플릿)은 helper 한 곳에 명시적으로 모아 두어, 정책 변경 시 수정 지점이 하나입니다.

## 📡 API

모든 엔드포인트(`/api/health`, `/api/auth/login` 제외)는 `Authorization: Bearer <JWT>`가 필요합니다.

| Method | Path | 설명 |
|---|---|---|
| GET | `/api/health` | 헬스체크 |
| POST | `/api/auth/login` | 관리자 로그인 → JWT 발급 |
| POST | `/api/auth/admins` | 관리자 계정 추가 |
| GET | `/api/accounts/rbac-templates` | 선택 가능한 RBAC 템플릿 목록 |
| GET | `/api/accounts?namespace=` | 발급된 개발자 계정 목록 |
| POST | `/api/accounts` | 개발자 계정 발급 (`namespace`, `name`, `rbacTemplate`) → kubeconfig 반환 |
| DELETE | `/api/accounts/:namespace/:name` | 개발자 계정 회수 |
| GET | `/api/manifests/kinds` | 관리 가능한 Kind 목록 |
| GET | `/api/manifests?namespace=&kind=` | Kind별 리소스 목록 |
| GET | `/api/manifests/one?namespace=&kind=&name=` | 리소스 단건 조회 (편집용으로 정제) |
| GET | `/api/manifests/by-pod?namespace=&pod=` | Pod 연관 리소스 묶음 조회 |
| PUT | `/api/manifests` | 매니페스트 생성/수정 (upsert). 조회는 모든 네임스페이스, 수정·삭제는 `ISSUABLE_NAMESPACES` 에서만(그 밖은 403) |
| DELETE | `/api/manifests?apiVersion=&kind=&namespace=&name=` | 리소스 삭제 |
| GET | `/api/manifests/history?namespace=` | 변경 감사 이력 (최근 200건) |
| GET | `/api/gitea/users` | Gitea 사용자 목록 (팀, 차단 여부, 보호 사유) |
| GET | `/api/gitea/teams` | myorg 조직 팀 목록 + 구성원 + 보호 여부 |
| POST | `/api/gitea/users` | 사용자 생성 (`username`, `email`, `fullName?`, `teams?`) → 임시 비밀번호 |
| PATCH | `/api/gitea/users/:username/login` | 로그인 차단/허용 (`prohibitLogin`) |
| POST | `/api/gitea/users/:username/reset-password` | 비밀번호 초기화 (`mustChange?`, 기본 true) → 임시 비밀번호 |
| PUT | `/api/gitea/teams/:team/members/:username` | 팀 구성원 추가 |
| DELETE | `/api/gitea/teams/:team/members/:username` | 팀 구성원 제거 |
| GET | `/api/audit?action=&actor=&target=&result=&before=&limit=` | 관리 작업 이력. 최신순, `limit` 기본 50·최대 200, `before=<id>`로 다음 페이지, `action=account.*`처럼 접두어 검색 |

<details>
<summary>예시: 개발자 계정 발급</summary>

```bash
curl -X POST http://localhost:8100/api/accounts \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"namespace":"rag-system","name":"dev-alice","rbacTemplate":"readonly"}'
```

```json
{
  "namespace": "rag-system",
  "name": "dev-alice",
  "rbacTemplate": "readonly",
  "kubeconfig": "apiVersion: v1\nkind: Config\n..."
}
```
</details>

## 🗄 데이터 모델

| 테이블 | 용도 |
|---|---|
| `admin_users` | 관리자 계정 (username, bcrypt 해시) |
| `account_issuances` | 개발자 계정 발급/회수 이력 (`revoked_at IS NULL` = 활성) |
| `manifest_history` | 매니페스트 create / update / delete 감사 로그 (적용된 매니페스트 JSONB 포함) |
| `audit_log` | 모든 관리 작업 이력 (로그인·발급·회수·YAML·관리자 추가, 성공/실패) |

스키마는 기동 시 `CREATE TABLE IF NOT EXISTS`로 자동 생성됩니다.

## 🚀 실행 방법

### 로컬

```bash
cp .env.example .env   # PGPASSWORD, JWT_SECRET, ADMIN_BOOTSTRAP_* 등 채우기
npm install
npm run dev            # node --watch
```

클러스터 밖에서 실행하면 `KUBECONFIG`(기본값 `~/.kube/config`)를 사용하고,
클러스터 안에서는 Pod의 ServiceAccount로 자동 인증합니다.

### Docker

```bash
docker build -t admin-manager .
docker run --env-file .env -p 8100:8100 admin-manager
```

### 환경 변수

| 이름 | 설명 | 기본값 |
|---|---|---|
| `PORT` | 서버 포트 | `8100` |
| `ALLOWED_ORIGINS` | CORS 허용 Origin (쉼표 구분) | 전체 허용 |
| `PGHOST` / `PGPORT` / `PGDATABASE` / `PGUSER` / `PGPASSWORD` | PostgreSQL 접속 정보 | — |
| `JWT_SECRET` | JWT 서명 키 (**필수**) | — |
| `JWT_EXPIRES_IN` | JWT 만료 | `8h` |
| `GITEA_BASE_URL` | Gitea 주소 (비우면 Gitea 관리 API 503) | — |
| `GITEA_MGMT_TOKEN` | site admin 토큰 (write:admin, write:organization, write:user) | — |
| `GITEA_ORG` | 팀을 관리할 조직 | `myorg` |
| `GITEA_PROTECTED_TEAMS` | 보호 팀 (쉼표, 끝의 `*`는 접두어) | `Owners,ci-*,svc-*` |
| `ADMIN_BOOTSTRAP_USERNAME` / `ADMIN_BOOTSTRAP_PASSWORD` | 최초 관리자 계정 (`admin_users`가 비어 있을 때만 사용. 계정이 만들어지면 Secret에서 지운다) | — |
| `KUBECONFIG` | 로컬 개발용 kubeconfig 경로 | `~/.kube/config` |

## 🔐 설계 포인트 & 고민한 점

- **최소 권한 원칙**: 조회 서버와 변경 서버를 분리하고, DB 계정까지 분리해서 한쪽이 뚫려도 피해 범위를 줄임
- **명시적 허용(Allow-list) 정책**: 허용 Kind와 RBAC 템플릿을 코드에 고정하고, 새 항목은 명시적으로 추가해야만 허용
- **Secret 비관여 원칙**: 가장 민감한 데이터의 단일 유출 지점이 되지 않도록 Secret 값은 다루지 않고 `kubectl`로만 관리
- **만료되는 토큰**: 영구 토큰이 붙는 레거시 SA Secret 방식 대신 TokenRequest API(1년 만료) 사용
- **감사 가능성(Auditability)**: 모든 변경과 계정 발급에 작업자와 시각을 기록
- **동시 편집 안전성**: `resourceVersion` 기반 낙관적 락으로 Lost Update 방지
- **컨테이너 보안**: 베이스 이미지 버전 고정, `npm ci --omit=dev`, non-root(`USER node`)로 실행

## 🧭 향후 개선 계획

- [ ] 발급한 kubeconfig 토큰 갱신(재발급) 기능
- [ ] CRD(HTTPRoute) 수정 시 `MergePatch` 전략 적용
- [ ] 정식 DB 마이그레이션 도구 도입
- [ ] 로그인 시도 제한 (rate limiting)
- [ ] 단위 / 통합 테스트 추가
