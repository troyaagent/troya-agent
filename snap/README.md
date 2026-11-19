# Troya Gate Snap

Troya Gate on MetaMask's confirm screen for Robinhood Chain (chain 4663). Before you confirm a transaction, the Snap asks
`https://troya.codes/api/gate/tx` which coins it touches (the target and any token address in the calldata, routers and known
infrastructure left out) and shows each coin's Troya Gate verdict, Ring Radar's reading, and warnings such as an unlimited
approval to a contract Troya does not know. A failed coin or a warning raises MetaMask's critical banner.

Only `from`, `to`, `data` and `value` of the transaction are sent; the Snap signs nothing and stores nothing.

```sh
npm install
npm run build      # dist/bundle.js, shasum written into snap.manifest.json
npm test           # runs dist/bundle.js against real Robinhood Chain transactions (asks troya.codes)
npm run serve      # local install in MetaMask Flask: snap id local:http://localhost:8080
```

Permissions: `endowment:transaction-insight` and `endowment:network-access`. Platform 12.1.0 (MetaMask production).
