# DGEN

DGEN is a web-based bitcoin wallet. You can use it to send and receive Bitcoin on-chain and Lightning payments.

This repository contains the code for the API server. The frontend code is at <a href="https://github.com/DGEN-Technologies/dgen-ui">https://github.com/DGEN-Technologies/dgen-ui</a>

## Requirements

- [Bun](https://bun.sh) runtime
- Redis or KeyDB

## Quick Install

1. Clone the repository:
```bash
git clone https://github.com/DGEN-Technologies/dgen-server
cd dgen-server
```

2. Install dependencies:
```bash
bun install
```

3. Configure environment:
```bash
cp .env.example .env
# Edit .env with your configuration
```

4. Run the server:
```bash
bun index.ts
```

## Understanding DGEN

DGEN comprises the following components:
- **DGEN Server:** The main API server that handles wallet operations
- **[KeyDB](https://docs.keydb.dev/):** High performance Redis fork for data storage
- **WebSockets:** Real-time updates for transactions and balances

## License

This project is licensed under AGPL-3.0.