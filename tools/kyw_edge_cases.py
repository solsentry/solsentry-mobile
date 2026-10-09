"""Build tests/fixtures/kyw_edge_cases.json: hand-made getTransaction bodies and what the Python
reference (integrations/kyw/fact.py of the server repo) answers for each.

Usage: python3 tools/kyw_edge_cases.py <path to the server repo checkout> > tests/fixtures/kyw_edge_cases.json
"""
import copy
import json
import sys

sys.path.insert(0, sys.argv[1])
from integrations.kyw.fact import fact_digest, read_outcome  # noqa: E402

BASE = {
    "slot": 1,
    "blockTime": 2,
    "meta": {
        "err": None,
        "fee": 5000,
        "preBalances": [10, 20, 30],
        "postBalances": [5, 25, 30],
        "preTokenBalances": [],
        "postTokenBalances": [],
        "innerInstructions": [],
    },
    "transaction": {"message": {"accountKeys": ["A", "B", "P"], "instructions": [{"programIdIndex": 2}]}},
}


def case(name, edit=None, raw=None):
    if raw is None:
        result = copy.deepcopy(BASE)
        if edit:
            edit(result)
        raw = json.dumps({"jsonrpc": "2.0", "id": 1, "result": result}, ensure_ascii=False)
    return name, raw


def tok(index, mint, owner, amount):
    entry = {"accountIndex": index, "mint": mint, "uiTokenAmount": {"amount": amount, "decimals": 6, "uiAmount": 1.5}}
    if owner is not ...:
        entry["owner"] = owner
    return entry


def set_(path, value):
    def edit(result):
        node = result
        for key in path[:-1]:
            node = node[key]
        node[path[-1]] = value
    return edit


def drop(path):
    def edit(result):
        node = result
        for key in path[:-1]:
            node = node[key]
        del node[path[-1]]
    return edit


CASES = [
    case("base"),
    case("failed", set_(["meta", "err"], {"InstructionError": [0, {"Custom": 1}]})),
    case("blocktime_null", set_(["blockTime"], None)),
    case("blocktime_missing", drop(["blockTime"])),
    case("token_lists_null", lambda r: r["meta"].update(preTokenBalances=None, innerInstructions=None)),
    case("token_lists_missing", lambda r: [r["meta"].pop(k) for k in ("preTokenBalances", "postTokenBalances", "innerInstructions")]),
    case("token_sort_and_owner", set_(["meta", "postTokenBalances"], [
        tok(2, "MintB", "OwnerZ", "10"), tok(1, "MintA", ..., "7"), tok(10, "MintA", None, "0"), tok(1, "MintA", "OwnerA", "7"),
    ])),
    case("token_amount_number", set_(["meta", "preTokenBalances"], [{"accountIndex": 1, "mint": "M", "uiTokenAmount": {"amount": 7}}])),
    case("token_float_index", set_(["meta", "preTokenBalances"], [{"accountIndex": 1.0, "mint": "M", "uiTokenAmount": {"amount": "7"}}])),
    case("inner_sorted", set_(["meta", "innerInstructions"], [
        {"index": 10, "instructions": [{"programId": "X"}]},
        {"index": 2, "instructions": [{"programIdIndex": 0}, {"programId": "Y", "parsed": {"a": 1.5}}]},
    ])),
    case("parsed_keys", set_(["transaction", "message", "accountKeys"], [
        {"pubkey": "A", "signer": True, "source": "transaction", "writable": True},
        {"pubkey": "B", "signer": False, "source": "transaction", "writable": True},
        {"pubkey": "L", "signer": False, "source": "lookupTable", "writable": False},
    ])),
    case("loaded_appended", lambda r: r["meta"].update(loadedAddresses={"writable": ["W"], "readonly": ["R"]})),
    case("loaded_already_expanded", lambda r: (
        r["meta"].update(loadedAddresses={"writable": ["B"], "readonly": ["P"]}),
    )),
    case("loaded_with_lookup_source", lambda r: (
        r["meta"].update(loadedAddresses={"writable": ["L"], "readonly": []}),
        r["transaction"]["message"].update(accountKeys=[{"pubkey": "A"}, {"pubkey": "L", "source": "lookupTable"}],
                                           instructions=[{"programIdIndex": 1}]),
    )),
    case("loaded_empty", lambda r: r["meta"].update(loadedAddresses={"writable": [], "readonly": []})),
    case("loaded_null", lambda r: r["meta"].update(loadedAddresses=None)),
    case("program_index_out_of_range", set_(["transaction", "message", "instructions"], [{"programIdIndex": 9}])),
    case("program_index_negative", set_(["transaction", "message", "instructions"], [{"programIdIndex": -1}])),
    case("program_index_missing", set_(["transaction", "message", "instructions"], [{}])),
    case("missing_fee", drop(["meta", "fee"])),
    case("missing_err", drop(["meta", "err"])),
    case("missing_slot", drop(["slot"])),
    case("missing_transaction", drop(["transaction"])),
    case("unicode_and_escapes", set_(["transaction", "message", "accountKeys"], ["é \U0001F600", "a\"b\\c\n\t\u0001\u007f", "￿"])),
    case("big_ints", lambda r: r["meta"].update(preBalances=[2**64 - 1, 0, 2**53 + 1], fee=2**63)),
    case("raw_negative_zero", raw='{"result":{"slot":-0,"blockTime":null,"meta":{"err":null,"fee":0,"preBalances":[],"postBalances":[]},"transaction":{"message":{"accountKeys":[],"instructions":[]}}}}'),
    case("raw_exponent", raw='{"result":{"slot":1e3,"blockTime":null,"meta":{"err":null,"fee":0,"preBalances":[],"postBalances":[]},"transaction":{"message":{"accountKeys":[],"instructions":[]}}}}'),
    case("raw_float_outside_fact", raw='{"result":{"slot":1,"blockTime":null,"version":0.5,"meta":{"err":null,"fee":0,"computeUnitsConsumed":1.5,"preBalances":[],"postBalances":[]},"transaction":{"message":{"accountKeys":[],"instructions":[]}}}}'),
    case("raw_duplicate_key", raw='{"result":{"slot":1,"slot":2,"blockTime":null,"meta":{"err":null,"fee":0,"preBalances":[],"postBalances":[]},"transaction":{"message":{"accountKeys":[],"instructions":[]}}}}'),
    case("raw_whitespace", raw=' \n{"result" : {"slot":1,"blockTime":null,"meta":{"err":null,"fee":0,"preBalances":[ ],"postBalances":[]},"transaction":{"message":{"accountKeys":[],"instructions":[]}}}}\r\n'),
    case("raw_result_null", raw='{"jsonrpc":"2.0","result":null,"id":1}'),
    case("raw_no_result", raw='{"jsonrpc":"2.0","id":1}'),
    case("raw_error_plain", raw='{"error":{"code":-32000,"message":"Node is behind"}}'),
    case("raw_error_version", raw='{"error":{"code":-32015,"message":"Transaction version (0) is not supported"}}'),
    case("raw_error_429", raw='{"error":{"code":429,"message":"Too many requests"}}'),
    case("raw_error_rate_text", raw='{"error":{"code":-32005,"message":"Rate limit exceeded"}}'),
    case("raw_error_and_result", raw='{"error":{"code":1,"message":"x"},"result":{}}'),
    case("raw_result_string", raw='{"result":"abc"}'),
    case("raw_result_empty_object", raw='{"result":{}}'),
    case("meta_null", set_(["meta"], None)),
    case("raw_error_not_object", raw='{"error":"boom"}'),
    case("raw_top_level_list", raw='[]'),
    case("raw_not_json", raw='<html>502 Bad Gateway</html>'),
    case("raw_truncated", raw='{"result":{"slot":1,"meta":{"err":nul'),
    case("raw_empty", raw=''),
]

out = []
for name, raw in CASES:
    try:
        status, reason, fact = read_outcome(json.loads(raw))
        expected = {"status": status, "unknown_reason": reason, "fact_digest": fact_digest(fact) if fact else None}
    except json.JSONDecodeError:
        # The reference never sees a body that is not JSON; clients answer invalid_response.
        expected = {"status": "unknown", "unknown_reason": "invalid_response", "fact_digest": None, "note": "not JSON"}
    except Exception as exc:  # noqa: BLE001 - recorded, not hidden
        expected = {"reference_raised": type(exc).__name__}
    out.append({"name": name, "raw": raw, "expected": expected})
json.dump(out, sys.stdout, ensure_ascii=False, indent=1)
