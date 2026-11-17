export type Finding = {
  severity: "Error" | "Warning" | "Passed";
  category: string;
  qid: string;
  rule: string;
  message: string;
  line?: number;
};

type XmlTag = {
  name: string;
  attrs: string;
  index: number;
  end: number;
  raw: string;
};

const QUESTION_TAGS = new Set([
  "radio", "checkbox", "select", "number", "float", "text", "textarea",
  "essay", "rating", "slider", "rank", "ranksort", "ranking",
  "numbergrid", "floatgrid", "radioGrid", "checkboxGrid",
]);

function lineAt(source: string, index: number): number {
  return source.slice(0, index).split("\n").length;
}

function attributes(source: string): Record<string, string> {
  const result: Record<string, string> = {};
  const pattern = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    result[match[1]] = match[2] ?? match[3] ?? "";
  }
  return result;
}

function findTagEnd(source: string, start: number): number {
  let quote: "'" | '"' | null = null;
  for (let i = start; i < source.length; i += 1) {
    const char = source[i];
    if (quote) {
      if (char === quote) quote = null;
    } else if (char === "'" || char === '"') {
      quote = char;
    } else if (char === ">") {
      return i + 1;
    }
  }
  return -1;
}

function scanTags(source: string): XmlTag[] {
  const tags: XmlTag[] = [];
  const startPattern = /<(?![!/?])([A-Za-z_][\w:.-]*)\b/g;
  let match: RegExpExecArray | null;

  while ((match = startPattern.exec(source)) !== null) {
    const index = match.index;
    // Ignore markup inside comments and CDATA sections.
    const before = source.slice(0, index);
    const lastComment = before.lastIndexOf("<!--");
    const lastCommentEnd = before.lastIndexOf("-->");
    const lastCdata = before.lastIndexOf("<![CDATA[");
    const lastCdataEnd = before.lastIndexOf("]]>");
    if (lastComment > lastCommentEnd || lastCdata > lastCdataEnd) continue;

    const end = findTagEnd(source, startPattern.lastIndex);
    if (end < 0) continue;
    tags.push({
      name: match[1],
      attrs: source.slice(startPattern.lastIndex, end - 1),
      index,
      end,
      raw: source.slice(index, end),
    });
    startPattern.lastIndex = end;
  }
  return tags;
}

/**
 * Decipher XML can contain builder:/ss:/html: attributes whose namespace
 * declarations are omitted in exported source. Add temporary declarations
 * only to the parser copy; never mutate the XML that is displayed/exported.
 */
function parseWithNamespaceRepair(source: string): {
  valid: boolean;
  repaired: boolean;
  message?: string;
} {
  if (typeof DOMParser === "undefined") {
    return { valid: true, repaired: false };
  }

  const prefixes = new Set<string>();
  const prefixPattern = /(?:<\/?|\s)([A-Za-z_][\w.-]*):[A-Za-z_][\w.-]*/g;
  let match: RegExpExecArray | null;
  while ((match = prefixPattern.exec(source)) !== null) {
    if (match[1] !== "xmlns") prefixes.add(match[1]);
  }

  let parserCopy = source;
  const root = /<([A-Za-z_][\w:.-]*)\b/.exec(source);
  if (root && prefixes.size) {
    const rootStart = root.index;
    const tagEnd = findTagEnd(source, rootStart);
    if (tagEnd > 0) {
      const rootTag = source.slice(rootStart, tagEnd);
      const declarations: string[] = [];
      for (const prefix of prefixes) {
        if (!new RegExp("\\bxmlns:" + prefix.replace(/[.*+?^$()|[\]\\]/g, "\\$&") + "\\s*=").test(rootTag)) {
          declarations.push(`xmlns:${prefix}="urn:decipher-qa:auto:${prefix}"`);
        }
      }
      if (declarations.length) {
        parserCopy =
          source.slice(0, tagEnd - 1) +
          " " + declarations.join(" ") +
          source.slice(tagEnd - 1);
      }
    }
  }

  const doc = new DOMParser().parseFromString(parserCopy, "application/xml");
  const parserError = doc.querySelector("parsererror");
  if (parserError) {
    const message = (parserError.textContent || "XML is not well formed.")
      .replace(/\s+/g, " ")
      .trim();
    return { valid: false, repaired: false, message };
  }
  return { valid: true, repaired: parserCopy !== source };
}

function getQuestionId(tag: XmlTag): string {
  const attrs = attributes(tag.attrs);
  return attrs.label || attrs.id || "(no label)";
}

function isHiddenQuestion(attrs: Record<string, string>): boolean {
  const where = (attrs.where || "")
    .split(",")
    .map((part) => part.trim().toLowerCase());
  const condition = (attrs.cond || "").trim().toLowerCase();
  return where.includes("execute") || condition === "0" || condition === "false";
}

export function runChecks(xml: string): Finding[] {
  const findings: Finding[] = [];
  const add = (
    severity: Finding["severity"],
    category: string,
    qid: string,
    rule: string,
    message: string,
    index = 0,
  ) => findings.push({
    severity,
    category,
    qid,
    rule,
    message,
    line: lineAt(xml, Math.max(0, index)),
  });

  if (!xml.trim()) {
    add("Error", "XML source", "", "XML source", "No XML content was supplied.");
    return findings;
  }

  const parsed = parseWithNamespaceRepair(xml);
  if (parsed.valid) {
    add("Passed", "XML syntax", "", "XML well-formedness", "XML is well formed (including Decipher namespace prefixes).");
    if (parsed.repaired) {
      add(
        "Warning",
        "XML syntax",
        "",
        "Undeclared namespace prefixes",
        "One or more namespace prefixes were undeclared. Temporary namespace declarations were applied for validation; the original XML was left unchanged.",
      );
    }
  } else {
    // Keep running the survey QA rules. A strict XML parser error must not
    // prevent independent checks from inspecting recoverable question tags.
    add("Error", "XML syntax", "", "XML well-formedness", parsed.message || "XML is not well formed.");
  }

  const tags = scanTags(xml);
  const questions = tags.filter((tag) => QUESTION_TAGS.has(tag.name));

  for (const tag of questions) {
    const attrs = attributes(tag.attrs);
    const qid = getQuestionId(tag);
    const category = `Question · ${tag.name}`;

    // Macro rule: hidden/execute questions must be explicitly optional.
    if (isHiddenQuestion(attrs)) {
      if (attrs.optional !== "1") {
        add(
          "Error",
          category,
          qid,
          "Hidden question optional",
          "Question is hidden but not implemented as optional (optional=\"1\" is missing).",
          tag.index,
        );
      } else {
        add("Passed", category, qid, "Hidden question optional", 'Hidden question includes optional="1".', tag.index);
      }
    }

    if (tag.name === "checkbox" || tag.name === "checkboxGrid") {
      if (!attrs.atleast) {
        add("Warning", category, qid, "Checkbox atleast", "Checkbox question does not define an atleast attribute; verify whether one is required.", tag.index);
      } else {
        add("Passed", category, qid, "Checkbox atleast", "atleast attribute is present.", tag.index);
      }
    }

    if (["radio", "checkbox", "select"].includes(tag.name)) {
      const closeTag = new RegExp(`</\\s*${tag.name}\\s*>`, "i");
      const remainder = xml.slice(tag.end);
      const close = closeTag.exec(remainder);
      const body = close ? remainder.slice(0, close.index) : remainder;
      const optionPattern = /<(row|choice|option)\b((?:"[^"]*"|'[^']*'|[^'">])*)>/gi;
      let option: RegExpExecArray | null;
      while ((option = optionPattern.exec(body)) !== null) {
        const optionAttrs = attributes(option[2]);
        const label = optionAttrs.label || optionAttrs.value || "";
        const textStart = option.index + option[0].length;
        const textEnd = body.indexOf(`</${option[1]}>`, textStart);
        const optionText = textEnd >= 0 ? body.slice(textStart, textEnd) : "";
        const optionName = `${label} ${optionText}`.replace(/<[^>]*>/g, " ").trim();

        if (/\bother\b/i.test(optionName) && ["radio", "checkbox"].includes(tag.name)) {
          if (optionAttrs.open !== "1") {
            add("Error", category, qid, "Other option open", 'Other option should include open="1".', tag.index);
          } else {
            add("Passed", category, qid, "Other option open", "Other option open attribute is present.", tag.index);
          }
          if (optionAttrs.randomize !== "0") {
            add("Warning", category, qid, "Other option randomize", 'Review randomize="0" for the Other option.', tag.index);
          }
        }

        if (/none of the above|none of these/i.test(optionName) && tag.name === "checkbox" && optionAttrs.exclusive !== "1") {
          add("Error", category, qid, "Exclusive none option", 'None of the above option should include exclusive="1".', tag.index);
        }
      }
    }

    if (["rank", "ranking", "ranksort"].includes(tag.name)) {
      if (!attrs.minRanks) {
        add("Warning", category, qid, "Minimum ranks", "Ranking question does not define minRanks; verify the required minimum.", tag.index);
      } else {
        add("Passed", category, qid, "Minimum ranks", "minRanks is present.", tag.index);
      }
    }

    if (["number", "float"].includes(tag.name) && /percent|percentage/i.test(tag.raw)) {
      if (!attrs.range) {
        add("Warning", category, qid, "Percentage range", 'Percentage question may require range="0,100".', tag.index);
      } else {
        add("Passed", category, qid, "Percentage range", "Range attribute is present.", tag.index);
      }
    }

    if (tag.name === "select") {
      const hasListDisplay = Object.prototype.hasOwnProperty.call(attrs, "ss:listDisplay");
      const hasSurveyDisplay =
        Object.prototype.hasOwnProperty.call(attrs, "surveyDisplay") ||
        Object.prototype.hasOwnProperty.call(attrs, "ss:surveyDisplay");
      if (!hasListDisplay || !hasSurveyDisplay) {
        const missing = [
          !hasListDisplay ? "ss:listDisplay" : "",
          !hasSurveyDisplay ? "surveyDisplay" : "",
        ].filter(Boolean).join(" and ");
        add(
          "Warning",
          category,
          qid,
          "Select display attributes",
          `${missing} not added.`,
          tag.index,
        );
      } else {
        add("Passed", category, qid, "Select display attributes", "ss:listDisplay and surveyDisplay attributes are present.", tag.index);
      }
    }
  }

  const rowCount = (xml.match(/<row\b/gi) || []).length;
  if (rowCount > 20 && !/multicol\.7/i.test(xml)) {
    add("Warning", "Survey layout", "", "Multicolumn display", `${rowCount} rows detected; review whether multicol.7 should be applied.`);
  }

  if (!questions.length) {
    add("Warning", "Question detection", "", "Question elements", "No recognized Decipher question elements were detected. Verify the XML structure.");
  }

  return findings;
}
