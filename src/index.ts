#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { XMLParser } from "fast-xml-parser";

// Jira 4.2.2 설정
const JIRA_BASE_URL = process.env.JIRA_BASE_URL || "";
const JIRA_USERNAME = process.env.JIRA_USERNAME || "";
const JIRA_PASSWORD = process.env.JIRA_PASSWORD || "";

// Basic Auth 헤더 생성
const authHeader = `Basic ${Buffer.from(`${JIRA_USERNAME}:${JIRA_PASSWORD}`).toString("base64")}`;

// Jira API 호출 함수 (4.2.2는 api/latest 사용)
async function jiraRequest(endpoint: string, method = "GET", body?: any) {
  const url = `${JIRA_BASE_URL}/rest/api/latest${endpoint}`;
  const options: RequestInit = {
    method,
    headers: {
      "Authorization": authHeader,
      "Content-Type": "application/json",
    },
  };

  if (body) {
    options.body = JSON.stringify(body);
  }

  try {
    const response = await fetch(url, options);
    
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Jira API error (${response.status}): ${error}`);
    }

    const text = await response.text();
    return text ? JSON.parse(text) : {};
  } catch (error) {
    throw new Error(`Jira connection failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// 이슈 검색 (JQL 사용) - Jira 4.2.2는 XML 뷰를 사용
async function searchIssues(jql: string, maxResults = 50) {
  const url = `${JIRA_BASE_URL}/sr/jira.issueviews:searchrequest-xml/temp/SearchRequest.xml?jqlQuery=${encodeURIComponent(jql)}&tempMax=${maxResults}`;
  
  const options: RequestInit = {
    method: 'GET',
    headers: {
      "Authorization": authHeader,
      "Accept": "application/xml",
    },
  };

  try {
    const response = await fetch(url, options);
    
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Jira XML search error (${response.status}): ${error}`);
    }

    const xmlText = await response.text();
    return parseSearchXML(xmlText);
  } catch (error) {
    throw new Error(`Jira XML search failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// XML 파싱 함수
function parseSearchXML(xmlText: string): any {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    textNodeName: "#text",
    parseTagValue: false,
    trimValues: true,
    processEntities: true,
    htmlEntities: true,
  });

  const result = parser.parse(xmlText);
  
  // RSS 구조에서 데이터 추출
  const channel = result.rss?.channel;
  if (!channel) {
    return { total: 0, maxResults: 0, issues: [] };
  }

  // total 값 추출
  const issueInfo = channel.issue;
  const total = issueInfo?.["@_total"] ? parseInt(issueInfo["@_total"]) : 0;

  // item들을 배열로 정규화
  let items = channel.item;
  if (!items) {
    return { total, maxResults: 0, issues: [] };
  }
  if (!Array.isArray(items)) {
    items = [items];
  }

  // 이슈 정보 추출
  const issues = items.map((item: any) => {
    return {
      key: item.key?.["#text"] || item.key || "",
      summary: item.summary || "",
      title: item.title || "",
      status: item.status?.["#text"] || item.status || "",
      priority: item.priority?.["#text"] || item.priority || "",
      assignee: item.assignee?.["#text"] || item.assignee || "Unassigned",
      assigneeUsername: item.assignee?.["@_username"] || "",
      reporter: item.reporter?.["#text"] || item.reporter || "",
      reporterUsername: item.reporter?.["@_username"] || "",
      created: item.created || "",
      updated: item.updated || "",
      type: item.type?.["#text"] || item.type || "",
      resolution: item.resolution || "",
      project: item.project?.["#text"] || item.project || "",
      projectKey: item.project?.["@_key"] || "",
    };
  });

  return {
    total,
    maxResults: issues.length,
    issues
  };
}

// 이슈 상세 정보 가져오기
async function getIssue(issueKey: string) {
  return jiraRequest(`/issue/${issueKey}`);
}

// 특정 프로젝트 정보 가져오기
async function getProject(projectKey: string) {
  return jiraRequest(`/project/${projectKey}`);
}

// MCP 서버 생성
const server = new Server(
  {
    name: "jira-mcp-server",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// 도구 목록 제공
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "search_jira_issues",
        description: "JQL을 사용하여 Jira 이슈를 검색합니다. 예: 'project = PROJ AND status = Open'. 중요: Jira 4.2.2 버전이므로 startOfDay(), endOfDay(), now() 같은 최신 JQL 함수는 지원하지 않습니다. 날짜 검색 시 반드시 'created >= \"2025-09-30\"' 또는 'created >= \"2025/09/30\"' 형식의 문자열 리터럴을 사용해야 합니다.",
        inputSchema: {
          type: "object",
          properties: {
            jql: {
              type: "string",
              description: "Jira Query Language (JQL) 검색 쿼리. 날짜는 문자열 형식으로 지정 (예: created >= \"2025-09-30\")",
            },
            maxResults: {
              type: "number",
              description: "최대 결과 수 (기본값: 50)",
              default: 50,
            },
          },
          required: ["jql"],
        },
      },
      {
        name: "get_jira_issue",
        description: "특정 Jira 이슈의 상세 정보를 가져옵니다",
        inputSchema: {
          type: "object",
          properties: {
            issueKey: {
              type: "string",
              description: "이슈 키 (예: PROJ-123)",
            },
          },
          required: ["issueKey"],
        },
      },
      {
        name: "get_jira_project",
        description: "특정 프로젝트의 상세 정보를 가져옵니다",
        inputSchema: {
          type: "object",
          properties: {
            projectKey: {
              type: "string",
              description: "프로젝트 키 (예: PROJ)",
            },
          },
          required: ["projectKey"],
        },
      },
    ],
  };
});

// 안전한 값 추출 함수
function safeGet(obj: any, path: string, defaultValue: any = ""): any {
  try {
    const keys = path.split('.');
    let result = obj;
    for (const key of keys) {
      if (result && typeof result === 'object' && key in result) {
        result = result[key];
      } else {
        return defaultValue;
      }
    }
    return result || defaultValue;
  } catch {
    return defaultValue;
  }
}

// 도구 실행 처리
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    if (request.params.name === "search_jira_issues") {
      const args = request.params.arguments as { jql: string; maxResults?: number };
      const result = await searchIssues(args.jql, args.maxResults);
      
      // XML 파싱에서 이미 평탄화된 구조를 반환하므로 직접 사용
      const issues = (result.issues || []).map((issue: any) => {
        return {
          key: issue.key || "",
          link: `${JIRA_BASE_URL}/browse/${issue.key}`,
          summary: issue.summary || "",
          status: issue.status || "Unknown",
          assignee: issue.assignee || "Unassigned",
          reporter: issue.reporter || "Unknown",
          created: issue.created || "",
          updated: issue.updated || "",
          description: "",
          priority: issue.priority || "None",
          issueType: issue.type || "Unknown",
        };
      });

      return {
        content: [
          {
            type: "text",
            text: `Jira 이슈 검색 결과입니다.
각 이슈의 정확한 링크는 'link' 필드를 참조하세요.
Jira Base URL: ${JIRA_BASE_URL}

${JSON.stringify({
  total: result.total || issues.length,
  maxResults: result.maxResults || args.maxResults,
  issues,
}, null, 2)}`,
          },
        ],
      };
    }

    if (request.params.name === "get_jira_issue") {
      const args = request.params.arguments as { issueKey: string };
      const issue = await getIssue(args.issueKey);
      const fields = issue.fields || {};

      // Jira 4.2.2는 fields가 객체 형태이고 value 속성에 실제 값이 있음
      const getFieldValue = (field: any) => {
        if (!field) return null;
        if (field.value !== undefined) return field.value;
        return field;
      };

      const componentsValue = getFieldValue(fields.components);
      const labelsValue = getFieldValue(fields.labels);

      const formattedIssue = {
        key: issue.key || "",
        link: `${JIRA_BASE_URL}/browse/${issue.key}`,
        summary: getFieldValue(fields.summary) || safeGet(fields, 'summary.value', ''),
        description: getFieldValue(fields.description) || safeGet(fields, 'description.value', ''),
        status: safeGet(fields, 'status.value.name') || safeGet(fields, 'status.name', 'Unknown'),
        priority: safeGet(fields, 'priority.value.name') || safeGet(fields, 'priority.name', 'None'),
        assignee: safeGet(fields, 'assignee.value.displayName') || safeGet(fields, 'assignee.displayName') || safeGet(fields, 'assignee.value.name') || safeGet(fields, 'assignee.name', 'Unassigned'),
        reporter: safeGet(fields, 'reporter.value.displayName') || safeGet(fields, 'reporter.displayName') || safeGet(fields, 'reporter.value.name') || safeGet(fields, 'reporter.name', 'Unknown'),
        created: getFieldValue(fields.created) || safeGet(fields, 'created.value', ''),
        updated: getFieldValue(fields.updated) || safeGet(fields, 'updated.value', ''),
        labels: Array.isArray(labelsValue) ? labelsValue : [],
        components: Array.isArray(componentsValue) ? componentsValue.map((c: any) => c.name || '') : [],
        issueType: safeGet(fields, 'issuetype.value.name') || safeGet(fields, 'issuetype.name', 'Unknown'),
        project: safeGet(fields, 'project.value.key') || safeGet(fields, 'project.key', 'Unknown'),
        projectName: safeGet(fields, 'project.value.name') || safeGet(fields, 'project.name', 'Unknown'),
      };

      return {
        content: [
          {
            type: "text",
            text: `Jira 이슈 상세 정보입니다.
정확한 링크: ${JIRA_BASE_URL}/browse/${issue.key}

${JSON.stringify(formattedIssue, null, 2)}`,
          },
        ],
      };
    }

    if (request.params.name === "get_jira_project") {
      const args = request.params.arguments as { projectKey: string };
      const project = await getProject(args.projectKey);

      const formattedProject = {
        key: project.key || "",
        name: project.name || "",
        link: `${JIRA_BASE_URL}/browse/${project.key}`,
        description: project.description || "",
        lead: safeGet(project, 'lead.displayName') || safeGet(project, 'lead.name', 'Unknown'),
        url: project.url || "",
        versions: (project.versions || []).map((v: any) => ({
          name: v.name || "",
          released: v.released || false,
        })),
        components: (project.components || []).map((c: any) => c.name || ""),
      };

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(formattedProject, null, 2),
          },
        ],
      };
    }

    throw new Error(`Unknown tool: ${request.params.name}`);
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: `Error: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
});

// 서버 시작
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Jira 4.2.2 MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
