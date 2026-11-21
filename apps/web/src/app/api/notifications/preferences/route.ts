import { NextRequest, NextResponse } from 'next/server';

export interface NotificationPreferences {
  inApp: boolean;
  email: boolean;
  emailAddress: string;
  webhook: boolean;
  webhookUrl: string;
  webhookSecret: string;
  monthlyReportEnabled: boolean;
  reportEmail: string;
}

const DEFAULT_PREFERENCES: NotificationPreferences = {
  inApp: true,
  email: false,
  emailAddress: '',
  webhook: false,
  webhookUrl: '',
  webhookSecret: '',
  monthlyReportEnabled: false,
  reportEmail: '',
};

// In-memory store keyed by operator id. Replace with persistent storage in production.
const preferencesStore = new Map<string, NotificationPreferences>();

function getOperatorId(req: NextRequest): string {
  const headerId = req.headers.get('x-operator-id');
  if (headerId && headerId.trim().length > 0) {
    return headerId.trim();
  }
  const queryId = req.nextUrl.searchParams.get('operatorId');
  if (queryId && queryId.trim().length > 0) {
    return queryId.trim();
  }
  return 'default';
}

function getPreferences(operatorId: string): NotificationPreferences {
  const stored = preferencesStore.get(operatorId);
  if (stored) {
    return { ...stored };
  }
  return { ...DEFAULT_PREFERENCES };
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isValidUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

interface ValidationResult {
  valid: boolean;
  errors: string[];
  preferences?: NotificationPreferences;
}

function validatePreferences(body: unknown): ValidationResult {
  const errors: string[] = [];

  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { valid: false, errors: ['Request body must be a JSON object.'] };
  }

  const input = body as Record<string, unknown>;

  const inApp = input.inApp === undefined ? DEFAULT_PREFERENCES.inApp : input.inApp;
  if (typeof inApp !== 'boolean') {
    errors.push('"inApp" must be a boolean.');
  }

  const email = input.email === undefined ? DEFAULT_PREFERENCES.email : input.email;
  if (typeof email !== 'boolean') {
    errors.push('"email" must be a boolean.');
  }

  const emailAddress =
    input.emailAddress === undefined ? DEFAULT_PREFERENCES.emailAddress : input.emailAddress;
  if (typeof emailAddress !== 'string') {
    errors.push('"emailAddress" must be a string.');
  } else if (email === true && emailAddress.trim().length === 0) {
    errors.push('"emailAddress" is required when email notifications are enabled.');
  } else if (emailAddress.trim().length > 0 && !EMAIL_REGEX.test(emailAddress.trim())) {
    errors.push('"emailAddress" must be a valid email address.');
  }

  const webhook = input.webhook === undefined ? DEFAULT_PREFERENCES.webhook : input.webhook;
  if (typeof webhook !== 'boolean') {
    errors.push('"webhook" must be a boolean.');
  }

  const webhookUrl =
    input.webhookUrl === undefined ? DEFAULT_PREFERENCES.webhookUrl : input.webhookUrl;
  if (typeof webhookUrl !== 'string') {
    errors.push('"webhookUrl" must be a string.');
  } else if (webhook === true && webhookUrl.trim().length === 0) {
    errors.push('"webhookUrl" is required when webhook notifications are enabled.');
  } else if (webhookUrl.trim().length > 0 && !isValidUrl(webhookUrl.trim())) {
    errors.push('"webhookUrl" must be a valid http(s) URL.');
  }

  const webhookSecret =
    input.webhookSecret === undefined ? DEFAULT_PREFERENCES.webhookSecret : input.webhookSecret;
  if (typeof webhookSecret !== 'string') {
    errors.push('"webhookSecret" must be a string.');
  }

  const monthlyReportEnabled =
    input.monthlyReportEnabled === undefined
      ? DEFAULT_PREFERENCES.monthlyReportEnabled
      : input.monthlyReportEnabled;
  if (typeof monthlyReportEnabled !== 'boolean') {
    errors.push('"monthlyReportEnabled" must be a boolean.');
  }

  const reportEmail =
    input.reportEmail === undefined ? DEFAULT_PREFERENCES.reportEmail : input.reportEmail;
  if (typeof reportEmail !== 'string') {
    errors.push('"reportEmail" must be a string.');
  } else if (reportEmail.trim().length > 0 && !EMAIL_REGEX.test(reportEmail.trim())) {
    errors.push('"reportEmail" must be a valid email address.');
  } else if (
    monthlyReportEnabled === true &&
    reportEmail.trim().length === 0 &&
    emailAddress.trim().length === 0
  ) {
    errors.push(
      '"reportEmail" or "emailAddress" is required when monthly report delivery is enabled.',
    );
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return {
    valid: true,
    errors: [],
    preferences: {
      inApp: inApp as boolean,
      email: email as boolean,
      emailAddress: (emailAddress as string).trim(),
      webhook: webhook as boolean,
      webhookUrl: (webhookUrl as string).trim(),
      webhookSecret: webhookSecret as string,
      monthlyReportEnabled: monthlyReportEnabled as boolean,
      reportEmail: (reportEmail as string).trim(),
    },
  };
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    const operatorId = getOperatorId(req);
    const preferences = getPreferences(operatorId);
    return NextResponse.json({ preferences }, { status: 200 });
  } catch (error) {
    return NextResponse.json(
      { error: 'Failed to retrieve notification preferences.' },
      { status: 500 },
    );
  }
}

export async function PUT(req: NextRequest): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  const result = validatePreferences(body);
  if (!result.valid || !result.preferences) {
    return NextResponse.json(
      { error: 'Validation failed.', details: result.errors },
      { status: 400 },
    );
  }

  try {
    const operatorId = getOperatorId(req);
    const existing = getPreferences(operatorId);
    const updated: NotificationPreferences = {
      ...existing,
      ...result.preferences,
    };
    preferencesStore.set(operatorId, updated);
    return NextResponse.json({ preferences: { ...updated } }, { status: 200 });
  } catch (error) {
    return NextResponse.json(
      { error: 'Failed to save notification preferences.' },
      { status: 500 },
    );
  }
}