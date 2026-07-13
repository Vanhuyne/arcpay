# ArcPay — MVP Design Spec

- **Ngày:** 2026-07-13
- **Trạng thái:** Đã duyệt, sẵn sàng lập kế hoạch triển khai
- **Mục tiêu:** Dự thi hackathon / xin grant của Circle trên Arc Chain

---

## 1. Tóm tắt

ArcPay là cổng thanh toán tại quầy (POS) chạy trên **Arc Chain** — Layer-1 của Circle dùng USDC làm native gas token.

Merchant tạo hoá đơn, hiện QR. Khách quét bằng camera điện thoại, mở trang checkout, bấm trả một lần, và màn hình merchant chuyển sang "ĐÃ THANH TOÁN" trong dưới một giây.

**Vì sao phải là Arc, không phải Base/Polygon:** trên mọi EVM chain khác, để trả bằng USDC khách vẫn phải giữ sẵn ETH/MATIC để trả gas. Một quán cà phê và khách hàng của họ sẽ không bao giờ làm việc đó. Trên Arc, gas cũng là USDC — khách chỉ cần **một tài sản duy nhất** trong ví. Cộng với finality dưới 1 giây và không có reorg, "đã thanh toán" thật sự có nghĩa là đã thanh toán, ngay tại quầy.

---

## 2. Bối cảnh kỹ thuật của Arc

Các dữ kiện dưới đây là nền tảng của mọi quyết định thiết kế trong tài liệu này.

| Thông số | Giá trị |
|---|---|
| Chain ID | `5042002` |
| RPC HTTP | `https://rpc.testnet.arc.network` |
| RPC WebSocket | `wss://rpc.testnet.arc.network` |
| Explorer | `https://testnet.arcscan.app` |
| Faucet | `https://faucet.circle.com` |
| Block time | ~0.48s |
| Finality | < 1s, deterministic (Malachite BFT), không reorg |
| Execution | Reth — EVM đầy đủ, baseline Osaka |
| Gas token | USDC (native) |
| Chi phí giao dịch mục tiêu | ~$0.01 |
| USDC ERC-20 interface | `0x3600000000000000000000000000000000000000` |

**Ba đặc điểm khác biệt được khai thác trực tiếp:**

1. **USDC là native gas.** Khách chỉ cần USDC, không cần token thứ hai. Đây là toàn bộ luận điểm sản phẩm.
2. **EIP-7708 — mọi chuyển USDC native đều phát ra `Transfer` log.** Trên Ethereum, gửi native token không sinh event, muốn phát hiện phải quét từng transaction. Trên Arc, phát hiện thanh toán chỉ là lắng nghe log.
3. **Finality < 1s.** Cho phép coi giao dịch là chung cuộc ngay tại quầy, không cần "chờ N xác nhận".

**Cảnh báo quan trọng — decimals kép:** USDC native dùng **18 decimals** (`msg.value`, gas), interface ERC-20 dùng **6 decimals** (`balanceOf`, `transfer`). Đây là **cùng một số dư**, hai cách biểu diễn. Trộn lẫn hai con số này sai một triệu lần. Xem mục 5.

---

## 3. Người dùng và chức năng

Đúng **hai** persona. Mỗi persona thêm vào là thêm màn hình, thêm state, thêm chỗ để hỏng lúc demo.

### 3.1. Merchant (người bán)

Ví là tài khoản. Đăng nhập bằng **SIWE** (Sign-In With Ethereum) — không email, không mật khẩu, không KYC. Địa chỉ ví đăng nhập cũng chính là địa chỉ nhận tiền, nên không có bước cấu hình tài khoản nhận.

| Chức năng | Mô tả |
|---|---|
| Tạo hoá đơn | Nhập số tiền (USDC) + mô tả ngắn. Hệ thống sinh `invoiceId` và link thanh toán. **Không tốn gas, không phải ký gì.** |
| Màn hình POS | Trang toàn màn hình, QR to, số tiền lớn. Tự cập nhật: chờ → **ĐÃ THANH TOÁN** + âm thanh. Đây là trái tim của demo. |
| Dashboard | Danh sách hoá đơn (pending / paid / expired), tổng doanh thu, số dư USDC của ví, link ArcScan từng giao dịch. |
| Chi tiết giao dịch | Ai trả, lúc nào, tx hash, **phí gas của giao dịch (do khách trả, tính bằng USDC)**, và **thời gian từ lúc bấm trả đến khi final**. |

### 3.2. Customer (người mua)

**Không có tài khoản và không bao giờ cần tạo.** Họ ghé qua một lần. Mọi ma sát ở đây là ma sát chết người.

1. Quét QR bằng camera điện thoại (không cần app riêng) → mở trang checkout. Trang hiện: trả cho ai, bao nhiêu, cho món gì.
2. Connect ví. Nếu ví chưa có mạng Arc → nút thêm mạng một chạm (`wallet_addEthereumChain`). Nếu chưa có USDC testnet → nút dẫn tới faucet Circle.
3. Bấm "Trả 5.00 USDC" → ký **đúng một** transaction → màn hình thành công + link explorer.

**Không approve token. Không cần giữ ETH để trả gas. Không đổi token.** Đây là điều phải hiện lên rõ ràng trên UI, không chỉ nằm trong slide.

### 3.3. Cố tình KHÔNG có trong MVP

Không nhân viên/phân quyền, không đa cửa hàng, không hoàn tiền, không thanh toán định kỳ, không fiat on-ramp, không admin platform.

Hai thứ được ưu tiên gắn thêm **nếu còn thời gian** (thiết kế chừa chỗ, nhưng không build): refund on-chain, và tự động đẩy doanh thu nhàn rỗi sang **USYC** để sinh lãi. Lưu ý USYC có contract `USYC Entitlements` — gần như chắc chắn cần whitelist, phải xác minh trước khi cam kết.

---

## 4. Smart contract — `PaymentRouter`

### 4.1. Quyết định: stateless router

Hoá đơn **không** được đăng ký on-chain trước. Cách "đúng sách" (merchant gọi `createInvoice()` rồi khách gọi `pay()`) sẽ bắt thu ngân mở ví và ký một transaction cho mỗi ly cà phê — không ai làm vậy, và nó buộc merchant phải luôn có USDC chỉ để tạo hoá đơn.

Thay vào đó: hoá đơn sống trong database, và khách mang theo `(invoiceId, merchant, amount)` trong calldata khi trả tiền.

**Hệ quả:** merchant **không bao giờ ký gì và không tốn một xu gas nào**. Tạo hoá đơn chỉ là một dòng `INSERT`. Toàn bộ chi phí on-chain do khách trả — đúng như ngoài đời.

### 4.2. Lỗ hổng của stateless và cách chặn

Nếu contract chống trùng bằng `paid[invoiceId]`, kẻ phá hoại có thể gọi `pay(invoiceId_của_bạn, ví_hắn, 0.01 USDC)`:
- Hoá đơn 500 USDC bị đánh dấu "đã trả" trên chain với giá 1 xu.
- Khi khách thật trả tiền, transaction **revert** vì "đã thanh toán rồi".
- Kẻ tấn công vô hiệu hoá được mọi hoá đơn với chi phí gần bằng 0.

**Cách chặn:** khoá chống trùng không phải `invoiceId`, mà là `keccak256(invoiceId, merchant, amount)`.

Kẻ phá hoại trả sai số tiền sẽ sinh ra một `key` hoàn toàn khác — hoá đơn thật vẫn trả được bình thường, hắn chỉ tự đốt tiền của mình. Và backend **chỉ tin event nào khớp cả ba trường với database** (mục 6.3), nên event rác bị vứt bỏ.

### 4.3. Mã nguồn

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Định tuyến thanh toán USDC native trên Arc và phát event để đối soát.
/// @dev Contract không giữ tiền: nhận bao nhiêu chuyển thẳng cho merchant bấy nhiêu.
///      Không owner, không upgrade, không hàm rút tiền.
contract PaymentRouter {
    /// @dev amount tính bằng 18 decimals (native USDC / msg.value).
    event InvoicePaid(
        bytes32 indexed invoiceId,
        address indexed merchant,
        address indexed payer,
        uint256 amount,
        uint64  timestamp
    );

    /// @dev key = keccak256(invoiceId, merchant, amount).
    ///      Khoá theo cả ba trường để một khoản trả sai số tiền không thể
    ///      chặn khoản trả đúng của cùng invoiceId.
    mapping(bytes32 => bool) public settled;

    error AlreadySettled();
    error AmountMismatch();
    error InvalidMerchant();
    error ForwardFailed();

    function pay(bytes32 invoiceId, address merchant, uint256 amount) external payable {
        if (merchant == address(0)) revert InvalidMerchant();
        if (msg.value != amount) revert AmountMismatch();

        bytes32 key = keccak256(abi.encode(invoiceId, merchant, amount));
        if (settled[key]) revert AlreadySettled();
        settled[key] = true;

        (bool ok, ) = merchant.call{value: amount}("");
        if (!ok) revert ForwardFailed();

        emit InvoicePaid(invoiceId, merchant, msg.sender, amount, uint64(block.timestamp));
    }
}
```

### 4.4. Tính chất an toàn

- **Chống reentrancy:** `settled[key] = true` được ghi **trước** khi chuyển tiền (checks-effects-interactions). Merchant dù là contract độc hại cũng không reentrancy được.
- **Không giữ được tiền của ai:** không owner, không upgrade, không hàm rút. Toàn bộ `msg.value` được forward ngay trong cùng transaction.
- **Địa chỉ zero:** Arc revert khi chuyển value tới `0x0`; ta chặn sớm bằng `InvalidMerchant` để lỗi rõ ràng hơn.

### 4.5. Đánh đổi đã chốt: forward, không escrow

Contract chuyển thẳng tiền cho merchant thay vì giữ làm escrow.

- **Được:** "tiền vào thẳng ví bạn trong 0.5 giây, không qua trung gian nào" — luận điểm mạnh, và contract không thể bị rút ruột.
- **Mất:** không refund on-chain được (muốn refund thì merchant tự chuyển ngược lại).

MVP đã thống nhất không có refund, nên đánh đổi này là thuần lợi.

---

## 5. Quy ước decimals (BẮT BUỘC)

Đây là nguồn bug nguy hiểm nhất của dự án. Xử lý bằng **kỷ luật**, không bằng sự cẩn thận.

| Tầng | Đơn vị | Ví dụ (5 USDC) |
|---|---|---|
| Database, mọi API, mọi UI | số nguyên **6 decimals** (kiểu "cents" của Stripe) | `5000000` |
| Mọi thứ chạm vào chain | `bigint` **18 decimals** | `5000000000000000000n` |
| Contract | chỉ biết `msg.value` (18 decimals) | — |

**Quy đổi chỉ được phép xảy ra trong đúng một file: `web/lib/usdc.ts`.**

```ts
export const USDC_SCALE = 10n ** 12n; // 18 - 6

export function toNative(amount6: bigint): bigint { return amount6 * USDC_SCALE; }
export function fromNative(wei: bigint): bigint  { return wei / USDC_SCALE; }
export function formatUsdc(amount6: bigint): string { /* "5.00" */ }
```

**Không component, route, hay hook nào khác được nhân/chia với `1e12`.** Vi phạm quy ước này là lỗi review chặn merge.

---

## 6. Kiến trúc và luồng dữ liệu

### 6.1. Nguyên tắc: không có indexer chạy thường trực

Kiến trúc thông thường cần một process Node ôm WebSocket, nghe log, ghi DB. Nó đúng, nhưng là **một server nữa phải deploy và giữ sống — và nó sẽ chết đúng lúc demo**.

Arc cho lối thoát đẹp hơn nhờ finality tức thì: **server có thể tự kiểm chứng một thanh toán chỉ bằng một lời gọi RPC.** Toàn bộ hệ thống chạy trên Vercel, không có process nào phải giữ sống, mà vẫn **không tin client một chữ nào**.

### 6.2. Luồng thanh toán

```
Merchant                    Server                     Chain                  Customer
   │                          │                          │                       │
   ├─ POST /api/invoices ────>│                          │                       │
   │  (SIWE session)          ├─ INSERT invoice          │                       │
   │<──── payUrl + QR ────────┤   (pending)              │                       │
   │                          │                          │                       │
   │  [màn hình POS]          │                          │                       │
   │  ├─ poll GET /:id (400ms)│                          │                       │
   │  └─ watch InvoicePaid ───┼─────────────────────────>│  (WSS, lọc invoiceId) │
   │                          │                          │                       │
   │                          │           quét QR ───────┼──────────────────────>│
   │                          │<──── GET /api/invoices/:id (public) ─────────────┤
   │                          │                          │<─── pay() 1 tx ───────┤
   │                          │                          │                       │
   │                          │                          ├─ InvoicePaid event    │
   │                          │                          ├─ tiền → ví merchant   │
   │                          │                          │                       │
   │                          │<──── POST /:id/confirm { txHash } ───────────────┤
   │                          │                          │      (gợi ý, KHÔNG tin)
   │                          ├─ eth_getTransactionReceipt(txHash) ──>│          │
   │                          ├─ XÁC MINH (mục 6.3)      │                       │
   │                          ├─ UPDATE status = paid    │                       │
   │                          │                          │                       │
   │<── "ĐÃ THANH TOÁN" ──────┤                          │                       │
```

**Ba đường phát hiện thanh toán, độc lập nhau, cùng đổ về một hàm xác minh:**

1. **Tab của khách** báo `txHash` sau khi có receipt (nhanh nhất, luôn có trong luồng bình thường).
2. **Màn hình POS của merchant** tự lắng nghe event `InvoicePaid` qua WebSocket, lọc theo `invoiceId`. Đường này sống độc lập với tab của khách — khách tắt tab vẫn không sao. POS thấy event thì cũng gửi `txHash` về `/confirm`.
3. **Vercel Cron mỗi phút** quét hoá đơn `pending`, gọi `eth_getLogs` lọc theo topic `invoiceId`, xác minh y hệt. Lưới an toàn cuối cùng cho trường hợp cả hai tab đều đã đóng.

Cái nào thấy trước thì kích hoạt trước. Hàm xác minh **idempotent**, nên chạy chồng nhau vô hại.

### 6.3. Hàm xác minh — nguồn sự thật duy nhất

`POST /api/invoices/:id/confirm { txHash }` — server coi `txHash` là **gợi ý**, không phải bằng chứng, và tự đi hỏi chain:

1. `eth_getTransactionReceipt(txHash)` → phải tồn tại và `status === 'success'`.
2. Receipt phải có log phát ra từ **đúng địa chỉ `PaymentRouter`**.
3. Decode log `InvoicePaid`, đối chiếu **cả ba** với bản ghi DB:
   - `invoiceId` khớp hoá đơn đang xét,
   - `merchant` đúng bằng ví merchant trong DB,
   - `amount` đúng bằng `toNative(amount6)` trong DB — **so sánh bằng tuyệt đối, không cho phép sai lệch**.
4. Chỉ khi cả ba khớp → `UPDATE status = 'paid'`, lưu `txHash`, `payer`, `blockNumber`, `paidAt`, `gasFee`.
5. Nếu hoá đơn đã `paid` → trả về thành công, không ghi lại (idempotent).

Client có thể nói dối thoải mái, không ăn thua gì. Sự thật nằm ở chain, và server luôn tự đi hỏi chain.

### 6.4. Vòng đời hoá đơn

Ba trạng thái, không hơn:

```
pending ──(xác minh thành công)──> paid
   │
   └──(quá expiresAt, 15 phút)──> expired
```

`expired` được suy ra từ trường `expiresAt` khi đọc, **không cần job xoá**.

**Tình huống hở đã xử lý:** nếu khách trả tiền vào hoá đơn đã `expired`, tiền vẫn về ví merchant thật (contract không biết gì về hạn). Server khi xác minh **vẫn chuyển hoá đơn sang `paid`** kèm cờ `wasLate = true`. Thà ghi nhận muộn còn hơn để tiền vào mà hệ thống nói "chưa trả" — đây đúng là kiểu tình huống làm vỡ demo hackathon.

---

## 7. Mô hình dữ liệu

```ts
// db/schema.ts — Drizzle + Postgres (Neon)

merchants {
  address     text primary key      // lowercase, checksum khi hiển thị
  name        text
  createdAt   timestamptz
}

invoices {
  id          text primary key      // invoiceId: 32 bytes hex, sinh ngẫu nhiên
  merchant    text references merchants(address)
  amount6     bigint                // 6 decimals — xem mục 5
  description text
  status      text                  // 'pending' | 'paid'   (expired suy ra từ expiresAt)
  createdAt   timestamptz
  expiresAt   timestamptz           // createdAt + 15 phút

  // điền khi xác minh thành công
  txHash      text
  payer       text
  blockNumber bigint
  paidAt      timestamptz
  gasFee      bigint                // 18 decimals, để khoe "phí trả bằng USDC"
  wasLate     boolean default false
}
```

`invoiceId` sinh ngẫu nhiên 32 bytes (không đoán được), dùng trực tiếp làm `bytes32` trong calldata.

---

## 8. API

| Endpoint | Auth | Mô tả |
|---|---|---|
| `POST /api/auth/siwe` | — | Xác thực SIWE, tạo session merchant |
| `POST /api/invoices` | SIWE | Tạo hoá đơn `{ amount6, description }` → `{ id, payUrl }` |
| `GET /api/invoices/:id` | public | Đọc hoá đơn (merchant, amount, description, status). Dùng bởi cả trang checkout lẫn POS. |
| `POST /api/invoices/:id/confirm` | public | Nhận `{ txHash }` (gợi ý) → chạy xác minh mục 6.3 |
| `GET /api/invoices` | SIWE | Danh sách hoá đơn của merchant + tổng doanh thu |
| `GET /api/cron/reconcile` | Cron secret | Đối soát hoá đơn pending qua `eth_getLogs` |

`GET /api/invoices/:id` để public là có chủ ý — khách không có tài khoản, và hoá đơn chỉ lộ ra khi biết `invoiceId` ngẫu nhiên 32 bytes.

---

## 9. Cấu trúc repo và stack

```
arcpay/
├─ contracts/                       Foundry
│  ├─ src/PaymentRouter.sol
│  ├─ test/PaymentRouter.t.sol
│  └─ script/Deploy.s.sol
└─ web/                             Next.js (App Router) — deploy Vercel
   ├─ app/
   │  ├─ dashboard/                 merchant: hoá đơn + doanh thu
   │  ├─ pos/[id]/                  merchant: QR toàn màn hình
   │  ├─ pay/[id]/                  customer: checkout ← trái tim demo
   │  └─ api/
   │     ├─ auth/siwe/
   │     ├─ invoices/
   │     ├─ invoices/[id]/confirm/
   │     └─ cron/reconcile/
   ├─ lib/
   │  ├─ arc.ts                     chain config, viem clients (HTTP + WSS)
   │  ├─ usdc.ts                    ← DUY NHẤT được quy đổi decimals
   │  ├─ router.ts                  ABI + địa chỉ PaymentRouter
   │  └─ verify.ts                  hàm xác minh mục 6.3 (dùng chung confirm + cron)
   └─ db/schema.ts                  Drizzle + Postgres (Neon)
```

| Thành phần | Lựa chọn | Lý do |
|---|---|---|
| Contract | **Foundry** | Test viết bằng Solidity, chạy nhanh; Arc docs khuyên dùng |
| Web | **Next.js App Router** trên Vercel | Không cần server thường trực |
| Chain | **viem + wagmi** | `viem` đã có Arc Testnet dựng sẵn — cần **xác minh lại ở bước đầu triển khai** |
| DB | **Neon Postgres** (Vercel Marketplace) | Serverless, không phải nuôi |
| Auth | **SIWE** | Ví là tài khoản, không mật khẩu |

`lib/verify.ts` được dùng chung bởi `/confirm` và `/cron/reconcile` — chỉ có **một** cài đặt của logic xác minh, không nhân bản.

---

## 10. Kế hoạch kiểm thử

### 10.1. Contract (Foundry)

| Test | Kỳ vọng |
|---|---|
| Trả đúng | Tiền tới merchant, event `InvoicePaid` đúng cả 5 trường |
| `msg.value` ≠ `amount` | Revert `AmountMismatch` |
| Trả trùng đúng bộ ba | Revert `AlreadySettled` |
| **Kẻ phá hoại trả sai số tiền KHÔNG chặn được hoá đơn thật** | Hoá đơn thật vẫn trả thành công — **test quan trọng nhất** |
| Merchant là contract độc hại reentrancy | Không rút được tiền thứ hai |
| `merchant == address(0)` | Revert `InvalidMerchant` |

### 10.2. Backend

| Test | Kỳ vọng |
|---|---|
| `confirm` với txHash bịa | Từ chối |
| txHash của hoá đơn **khác** | Từ chối |
| txHash đúng nhưng số tiền lệch | Từ chối |
| Log phát từ contract khác `PaymentRouter` | Từ chối |
| `confirm` hai lần | Chỉ ghi nhận một lần (idempotent) |
| Trả sau khi `expired` | `paid` + `wasLate = true` |

### 10.3. End-to-end (trên Arc testnet thật)

Deploy contract thật lên Arc testnet, chạy script trả tiền thật, kiểm tra hoá đơn chuyển sang `paid`.

**Đo và ghi lại:** thời gian từ lúc bấm "Trả" đến lúc transaction final, và phí gas thực tế (bằng USDC). Hai con số này lên slide.

---

## 11. Tiêu chí thành công của MVP

1. Trên Arc testnet thật: tạo hoá đơn → quét QR bằng điện thoại → trả → màn hình POS đổi trạng thái, **đo được dưới 1 giây**.
2. Khách hoàn tất thanh toán **chỉ với USDC trong ví** — không giữ token thứ hai, không approve, một chữ ký duy nhất.
3. Server **không tin client**: mọi cách giả mạo trong mục 10.2 đều bị từ chối.
4. Merchant **không tốn gas** và không ký gì trong toàn bộ vòng đời hoá đơn.
5. UI hiện rõ **phí gas trả bằng USDC** và **thời gian tới final** — bằng chứng sống cho luận điểm "vì sao là Arc".

---

## 12. Rủi ro đã biết

| Rủi ro | Mức | Xử lý |
|---|---|---|
| `viem` chưa thật sự có Arc Testnet dựng sẵn | Trung bình | Xác minh ngay bước đầu; nếu chưa có, tự định nghĩa chain (~10 dòng) |
| Nhầm 18 vs 6 decimals | **Cao** | Quy ước mục 5, cô lập trong `lib/usdc.ts`, có test |
| Ví di động không hỗ trợ mạng Arc | Trung bình | QR trỏ tới **URL checkout**, không phải EIP-681 — trang tự gọi `wallet_addEthereumChain` |
| RPC testnet chập chờn lúc demo | Trung bình | Cấu hình RPC dự phòng (Blockdaemon / dRPC / QuickNode) |
| USYC bị gate bởi Entitlements | Thấp (đã ngoài scope) | Chỉ là phần mở rộng, xác minh trước khi cam kết |

---

## 13. Ngoài phạm vi (theo thứ tự ưu tiên nếu còn thời gian)

1. **Refund on-chain** — cần đổi contract sang mô hình escrow.
2. **Doanh thu nhàn rỗi tự sinh lãi qua USYC** — cần xác minh Entitlements whitelist trước.
3. **Nạp tiền crosschain qua CCTP/Gateway** — khách trả từ Base/Ethereum.
4. **Gasless bằng EIP-7702** — Arc có hỗ trợ set-code transaction.
