function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function records(value: unknown): readonly Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function strings(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function cell(value: unknown): string {
  if (value === null || value === undefined || value === "") return "-";
  return String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
}

function listCell(value: unknown): string {
  const values = strings(value);
  return values.length === 0 ? "-" : values.map(cell).join("<br>");
}

function metricValue(value: unknown): string {
  if (!isRecord(value)) return "-";
  const unit = cell(value.unit);
  const currency = value.currency === null ? "" : ` ${cell(value.currency)}`;
  if (value.shape === "range") {
    return `${cell(value.lower_bound)}-${cell(value.upper_bound)} ${unit}${currency}`.trim();
  }
  if (value.shape === "index") {
    return `${cell(value.value)} ${unit} (${cell(value.index_base)})`;
  }
  if (value.shape === "estimate") {
    const bounds =
      value.lower_bound === null || value.upper_bound === null
        ? ""
        : ` [${cell(value.lower_bound)}, ${cell(value.upper_bound)}]`;
    return `${cell(value.value)}${bounds} ${unit}${currency} (estimate)`.trim();
  }
  return `${cell(value.value)} ${unit}${currency}`.trim();
}

function period(value: unknown): string {
  if (!isRecord(value)) return "-";
  if (value.as_of !== null) return `${cell(value.label)}; as of ${cell(value.as_of)}`;
  return `${cell(value.label)}; ${cell(value.period_start)} to ${cell(value.period_end)}`;
}

export function renderQuantitativeSignalTable(
  source: Readonly<Record<string, unknown>>,
  zh = false,
): string {
  const rows = records(source.quantitative_signal_rows);
  const headers = zh
    ? [
        "对象",
        "指标族 / 指标",
        "值",
        "口径",
        "地域",
        "周期",
        "测量类型",
        "可比性",
        "误差/不确定性",
        "来源",
      ]
    : [
        "Subject",
        "Metric Family / Metric",
        "Value",
        "Definition",
        "Geography",
        "Period",
        "Measurement",
        "Comparability",
        "Error / Uncertainty",
        "Sources",
      ];
  const body = rows.map((row) => {
    const observation = isRecord(row.observation) ? row.observation : {};
    const comparability = isRecord(observation.comparability) ? observation.comparability : {};
    return [
      observation.subject_id,
      `${cell(observation.metric_family)} / ${cell(observation.metric_name)} (${cell(observation.metric_semantics)})`,
      metricValue(observation.value),
      observation.metric_definition,
      observation.geography,
      period(observation.period),
      observation.measurement_type,
      `${cell(comparability.status)}; ${cell(comparability.category)}; ${
        comparability.direct_comparison_allowed === true
          ? zh
            ? "可直接比较"
            : "direct comparison allowed"
          : zh
            ? "不可直接比较"
            : "no direct comparison"
      }`,
      observation.error_uncertainty,
      listCell(observation.evidence_refs),
    ];
  });
  if (body.length === 0) {
    body.push([
      zh ? "全部" : "All",
      zh ? "无已观察量化信号" : "No observed quantitative signal",
      "-",
      zh ? "参见数据缺口表" : "See coverage gap table",
      "-",
      "-",
      "unavailable",
      zh ? "不可比较" : "not comparable",
      zh ? "无可用数值" : "no numeric value available",
      "-",
    ]);
  }
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...body.map((row) => `| ${row.map(cell).join(" | ")} |`),
    "",
  ].join("\n");
}

export function renderCompetitiveSubstituteMatrix(
  source: Readonly<Record<string, unknown>>,
  zh = false,
): string {
  const rows = records(source.competitive_substitute_rows);
  const headers = zh
    ? [
        "类型",
        "对象",
        "目标细分",
        "场景",
        "定位",
        "定价观察",
        "使用/市场信号",
        "优势",
        "弱点",
        "差异化缺口",
        "来源",
      ]
    : [
        "Type",
        "Object",
        "Target Segment",
        "Scenario",
        "Positioning",
        "Pricing Observations",
        "Traction Observations",
        "Strengths",
        "Weaknesses",
        "Differentiation Gaps",
        "Sources",
      ];
  const body = rows.map((row) => {
    const competitiveObject = isRecord(row.competitive_object) ? row.competitive_object : {};
    return [
      competitiveObject.competitor_type,
      competitiveObject.name,
      competitiveObject.target_segment,
      competitiveObject.scenario,
      competitiveObject.positioning,
      listCell(competitiveObject.pricing_observation_refs),
      listCell(competitiveObject.traction_observation_refs),
      listCell(competitiveObject.strengths),
      listCell(competitiveObject.weaknesses),
      listCell(competitiveObject.differentiation_gaps),
      listCell(competitiveObject.source_refs),
    ];
  });
  if (body.length === 0) {
    body.push([
      "unavailable",
      zh ? "没有已观察竞争对象" : "No observed competitive object",
      "-",
      "-",
      "-",
      "-",
      "-",
      "-",
      "-",
      zh ? "参见数据缺口表" : "See coverage gap table",
      "-",
    ]);
  }
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...body.map((row) => `| ${row.map(cell).join(" | ")} |`),
    "",
  ].join("\n");
}

export function renderResearchCoverageGaps(
  source: Readonly<Record<string, unknown>>,
  zh = false,
): string {
  const rows = records(source.research_coverage_gaps);
  const headers = zh
    ? ["对象", "覆盖类型", "维度", "状态", "查询尝试", "原因", "替代指标", "对排序/结论的影响"]
    : [
        "Subject",
        "Coverage Type",
        "Dimension",
        "State",
        "Query Attempts",
        "Reason",
        "Alternative Metric",
        "Ranking / Decision Impact",
      ];
  const body = rows.map((row) => {
    const coverage = isRecord(row.coverage) ? row.coverage : {};
    const attempts = records(coverage.query_attempts).map(
      (attempt) =>
        `${cell(attempt.acquisition_method)} / ${cell(attempt.provider)} / ${cell(attempt.outcome)}: ${cell(attempt.reason)}`,
    );
    return [
      coverage.subject_id,
      row.coverage_kind,
      row.coverage_kind === "quantitative" ? coverage.metric_family : coverage.competitor_type,
      coverage.state,
      attempts.length === 0 ? "-" : attempts.join("<br>"),
      coverage.reason,
      coverage.alternative_metric,
      coverage.decision_impact,
    ];
  });
  if (body.length === 0) {
    body.push([
      zh ? "全部" : "All",
      zh ? "量化与竞争" : "quantitative and competitive",
      zh ? "全部必需维度" : "all required dimensions",
      "observed",
      "-",
      zh ? "没有部分、不可用或不适用维度" : "No partial, unavailable, or not-applicable dimension",
      "-",
      zh ? "没有额外缺口影响" : "No additional gap impact",
    ]);
  }
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...body.map((row) => `| ${row.map(cell).join(" | ")} |`),
    "",
  ].join("\n");
}
