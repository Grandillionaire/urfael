# Training data export

Urfael turns your own archived runs into clean training datasets, locally and owner-only. This is the same idea as exporting agent trajectories for fine-tuning or RL, with three differences that come from what Urfael already keeps: a verified-knowledge dataset, provable provenance, and secret redaction by default.

```bash
urfael dataset stats
urfael dataset export --format all --out ~/urfael-dataset
```

`stats` summarises what is exportable (archived turns and verified lessons). `export` writes one JSONL file per format plus a `manifest.json`.

## The three formats

- **`sft`** is the standard supervised fine-tuning shape: one record per turn, `{ "messages": [ {role: "user"}, {role: "assistant"} ] }`, ready for an OpenAI-style fine-tune. Control markup (the `[SPOKEN]` voice tags) is stripped; the content is kept.
- **`atropos`** is a trajectory plus reward plus metadata record for RL pipelines. Archived turns are already success-filtered (the daemon never stores an aborted turn), so a completed turn carries reward `1.0`. Each record keeps its source date, channel, and model.
- **`lessons`** is the one Hermes cannot produce: a dataset built from the **verify-before-trust learning ledger**. Only `trusted` lessons are exported, each carrying the verifier's verdict (correct, general, safe) and a confidence score, sorted strongest first. A trainer can quality-gate with `--min-confidence` or weight by the confidence field. See [features/memory.md](features/memory.md) for how a lesson earns `trusted`.

## Provenance and privacy

- **Provenance.** Every record is stamped with its source (date, channel, model), and the manifest points at the tamper-evident [Ledger of Record](security/threat-model.md). Run `urfael audit --verify` to prove the archive the dataset was built from was not silently altered. A training set you can audit is the point.
- **Redaction.** Credential-shaped strings (API keys, tokens, private key blocks, `KEY=secret` pairs) are stripped to `[REDACTED]` before anything is written, and the count appears in the manifest. Pass `--no-redact` to keep them, and the export warns you when you do.
- **Local and owner-only.** Nothing leaves your machine. Review the output before you share it.

## Filtering

```bash
urfael dataset export --format sft --since "2026-05-01" --channel local --model opus
urfael dataset export --format lessons --min-confidence 0.7 --out ~/knowledge
```

Filter by `--since` / `--until` (dates), `--channel`, `--model`, and `--min-confidence` (lessons only). With no filter, the whole archive is exported.

## Honest scope

The reward in the `atropos` format is conservative on purpose: a completed turn is `1.0`, and lessons carry their verified confidence. Richer per-turn reward shaping needs a feedback signal Urfael does not capture yet, so it is not invented here. The strength of this export is not a clever reward, it is that the data is verifiable and the knowledge subset is verified.

## Related

- [features/memory.md](features/memory.md)
- [security/threat-model.md](security/threat-model.md)
- [reference/cli.md](reference/cli.md)
