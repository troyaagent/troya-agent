// Troya Gate Snap (V7 F38): on MetaMask's confirm screen for a Robinhood Chain (eip155:4663) transaction, ask Troya which
// coins it touches and show each one's Gate verdict, plus warnings such as an unlimited approval to an unknown contract.
// Only the transaction's from, to, data and value are sent to troya.codes; nothing is signed or stored by the Snap.
import type { OnTransactionHandler } from "@metamask/snaps-sdk";
import { SeverityLevel } from "@metamask/snaps-sdk";
import { Box, Heading, Text, Bold, Divider, Link, Row } from "@metamask/snaps-sdk/jsx";

const API = "https://troya.codes/api/gate/tx";
const WORD: Record<string, string> = { passed: "Passed", caution: "Caution", failed: "Failed", untested: "No buyers yet", unchecked: "Not checked" };

type Item = { token: string; symbol: string; verdict: string; reason: string | null; ring: string | null; url: string };
type Insight = { items: Item[]; warnings: string[]; summary: string; note: string };

export const onTransaction: OnTransactionHandler = async ({ transaction, chainId }) => {
  if (chainId !== "eip155:4663") {
    return { content: (<Box><Text>Troya Gate reads Robinhood Chain transactions only.</Text></Box>) };
  }
  let r: Insight;
  try {
    const res = await fetch(API, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chainId, from: transaction.from, to: transaction.to, data: transaction.data ?? "0x", value: transaction.value ?? "0x0" }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    r = (await res.json()) as Insight;
  } catch {
    return { content: (<Box><Heading>Troya Gate</Heading><Text>Troya could not be reached right now. Check the coin at troya.codes before you confirm.</Text></Box>) };
  }
  const bad = r.warnings.length > 0 || r.items.some((i) => i.verdict === "failed" || i.ring === "red");
  return {
    content: (
      <Box>
        <Heading>Troya Gate</Heading>
        <Text><Bold>{r.summary}</Bold></Text>
        {r.warnings.map((w) => (<Text>{`Warning: ${w}`}</Text>))}
        {r.items.length > 0 ? <Divider /> : null}
        {r.items.map((i) => (
          <Box>
            <Row label={`$${i.symbol}`}><Text>{WORD[i.verdict] ?? i.verdict}</Text></Row>
            {i.reason ? <Text>{i.reason}</Text> : null}
            {i.ring === "red" ? <Text>Ring Radar: rigged launch pattern.</Text> : i.ring === "amber" ? <Text>Ring Radar: the launch needs a closer look.</Text> : null}
            <Link href={i.url}>Open in Troya</Link>
          </Box>
        ))}
        <Divider />
        <Text>{r.note}</Text>
      </Box>
    ),
    ...(bad ? { severity: SeverityLevel.Critical } : {}),
  };
};
