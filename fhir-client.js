/**
 * fhir-client.js
 * ─────────────────────────────────────────────────────────────────────────
 * SMART on FHIR client for the Breast Cancer Staging app.
 *
 * Handles:
 *  1. SMART launch sequence (OAuth2 authorization code flow w/ PKCE)
 *  2. Token exchange and storage (sessionStorage — cleared on tab close)
 *  3. Fetching Patient demographics
 *  4. Searching Observation / DiagnosticReport for tumor markers
 *  5. Writing the completed staging summary back as a DocumentReference
 *
 * This file assumes it is loaded inside Epic's embedded browser via a
 * registered SMART app launch URL. It will NOT work standalone outside
 * an EHR launch context, by design — SMART apps must be launched with
 * a valid `iss` (issuer) and `launch` token provided by the EHR.
 *
 * Epic-specific notes:
 *  - Epic's FHIR R4 base URL is institution-specific, discovered via the
 *    `iss` parameter passed at launch — never hardcode it.
 *  - Epic requires PKCE (Proof Key for Code Exchange) for all SMART apps
 *    registered after 2021. This client implements PKCE by default.
 *  - Scopes must be requested and approved by the Epic analyst during
 *    App Orchard / Epic on FHIR registration. The scopes this app needs:
 *      launch
 *      openid fhirUser
 *      patient/Patient.read
 *      patient/Observation.read
 *      patient/DiagnosticReport.read
 *      patient/DocumentReference.write
 *      offline_access   (optional — only if refresh tokens are needed)
 */

const FHIR_CLIENT = (() => {

  // ── CONFIG ────────────────────────────────────────────────────────────
  // client_id is issued by Epic when your analyst registers this app in
  // App Orchard / Epic on FHIR. Replace before deployment.
  const CLIENT_ID = window.SMART_CLIENT_ID || 'REPLACE_WITH_EPIC_ISSUED_CLIENT_ID';

  // Must exactly match the redirect URI registered with Epic.
  const REDIRECT_URI = window.location.origin + window.location.pathname;

  const SCOPES = [
    'launch',
    'openid',
    'fhirUser',
    'patient/Patient.read',
    'patient/Observation.read',
    'patient/DiagnosticReport.read',
    'patient/DocumentReference.write'
  ].join(' ');

  let state = {
    iss: null,            // FHIR base URL, discovered at launch
    tokenEndpoint: null,
    authEndpoint: null,
    accessToken: null,
    patientId: null,
    encounterId: null,
  };

  // ── PKCE HELPERS ──────────────────────────────────────────────────────
  function base64url(buf) {
    return btoa(String.fromCharCode(...new Uint8Array(buf)))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  async function generatePKCE() {
    const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
    const data = new TextEncoder().encode(verifier);
    const digest = await crypto.subtle.digest('SHA-256', data);
    const challenge = base64url(digest);
    return { verifier, challenge };
  }

  // ── STEP 1: LAUNCH ────────────────────────────────────────────────────
  // Called when Epic launches the app inside a patient chart. Epic passes
  // `iss` (FHIR server base URL) and `launch` (opaque launch token) as
  // query params. We discover the SMART configuration, then redirect to
  // Epic's authorization endpoint.
  async function launch() {
    const params = new URLSearchParams(window.location.search);
    const iss = params.get('iss');
    const launchToken = params.get('launch');

    if (!iss || !launchToken) {
      throw new Error(
        'Missing iss/launch parameters. This app must be launched from ' +
        'within Epic (Hyperspace) via a registered SMART launch sequence, ' +
        'not opened directly as a standalone URL.'
      );
    }

    state.iss = iss;

    // Discover authorize/token endpoints via the SMART configuration
    // well-known endpoint (preferred) or CapabilityStatement (fallback).
    const conf = await fetch(`${iss}/.well-known/smart-configuration`)
      .then(r => r.json());
    state.authEndpoint = conf.authorization_endpoint;
    state.tokenEndpoint = conf.token_endpoint;

    const { verifier, challenge } = await generatePKCE();
    sessionStorage.setItem('pkce_verifier', verifier);
    sessionStorage.setItem('fhir_iss', iss);

    const authUrl = new URL(state.authEndpoint);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('client_id', CLIENT_ID);
    authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
    authUrl.searchParams.set('launch', launchToken);
    authUrl.searchParams.set('scope', SCOPES);
    authUrl.searchParams.set('state', crypto.randomUUID());
    authUrl.searchParams.set('aud', iss);
    authUrl.searchParams.set('code_challenge', challenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');

    window.location.assign(authUrl.toString());
  }

  // ── STEP 2: TOKEN EXCHANGE ────────────────────────────────────────────
  // Called when Epic redirects back to this app with an authorization
  // code. Exchanges the code for an access token.
  async function handleRedirect() {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    if (!code) return false;

    const verifier = sessionStorage.getItem('pkce_verifier');
    const iss = sessionStorage.getItem('fhir_iss');
    state.iss = iss;

    const conf = await fetch(`${iss}/.well-known/smart-configuration`)
      .then(r => r.json());
    state.tokenEndpoint = conf.token_endpoint;

    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
      client_id: CLIENT_ID,
      code_verifier: verifier
    });

    const res = await fetch(state.tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body
    });

    if (!res.ok) {
      throw new Error('Token exchange failed: ' + res.status + ' ' + await res.text());
    }

    const tokenResponse = await res.json();
    state.accessToken = tokenResponse.access_token;
    state.patientId = tokenResponse.patient;          // Epic includes this
    state.encounterId = tokenResponse.encounter;       // may be absent

    sessionStorage.setItem('fhir_access_token', state.accessToken);
    sessionStorage.setItem('fhir_patient_id', state.patientId || '');
    sessionStorage.setItem('fhir_encounter_id', state.encounterId || '');

    // Clean the code/state out of the URL bar
    window.history.replaceState({}, document.title, REDIRECT_URI);
    return true;
  }

  // Restore state from sessionStorage on page reload within the same tab
  function restoreSession() {
    state.accessToken = sessionStorage.getItem('fhir_access_token');
    state.patientId = sessionStorage.getItem('fhir_patient_id');
    state.encounterId = sessionStorage.getItem('fhir_encounter_id');
    state.iss = sessionStorage.getItem('fhir_iss');
    return !!state.accessToken;
  }

  // ── FHIR REQUEST HELPER ───────────────────────────────────────────────
  async function fhirGet(path) {
    const url = path.startsWith('http') ? path : `${state.iss}/${path}`;
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${state.accessToken}`,
        Accept: 'application/fhir+json'
      }
    });
    if (!res.ok) throw new Error(`FHIR GET ${path} failed: ${res.status}`);
    return res.json();
  }

  async function fhirPost(path, resource) {
    const url = `${state.iss}/${path}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${state.accessToken}`,
        'Content-Type': 'application/fhir+json',
        Accept: 'application/fhir+json'
      },
      body: JSON.stringify(resource)
    });
    if (!res.ok) throw new Error(`FHIR POST ${path} failed: ${res.status} ${await res.text()}`);
    return res.json();
  }

  // ── STEP 3: FETCH PATIENT DEMOGRAPHICS ───────────────────────────────
  async function getPatient() {
    if (!state.patientId) return null;
    const p = await fhirGet(`Patient/${state.patientId}`);
    const name = p.name?.[0];
    return {
      id: p.id,
      mrn: p.identifier?.find(i => i.type?.coding?.[0]?.code === 'MR')?.value || p.identifier?.[0]?.value,
      givenName: name?.given?.join(' ') || '',
      familyName: name?.family || '',
      dob: p.birthDate,
      sex: p.gender
    };
  }

  // ── STEP 4: SEARCH FOR EXISTING TUMOR MARKER OBSERVATIONS ───────────
  // Looks for LOINC-coded Observations commonly used for ER/PR/HER2 and
  // tumor size, plus DiagnosticReport for pathology narrative as fallback.
  // LOINC codes used (verify against your Epic build's actual mapping —
  // institutions sometimes use local codes instead of/alongside LOINC):
  //   16112-5  Estrogen receptor Ag [Presence] in Tissue
  //   16113-3  Progesterone receptor Ag [Presence] in Tissue
  //   85318-4  HER2 [Presence] in Tissue by Immune stain
  //   21889-1  Size.maximum dimension in Tumor
  const TUMOR_MARKER_CODES = {
    '16112-5': 'er',
    '16113-3': 'pr',
    '85318-4': 'her2',
    '21889-1': 'tumorSizeCm'
  };

  async function getTumorMarkers() {
    if (!state.patientId) return {};
    const codes = Object.keys(TUMOR_MARKER_CODES).join(',');
    let bundle;
    try {
      bundle = await fhirGet(
        `Observation?patient=${state.patientId}&code=${codes}&_sort=-date&_count=20`
      );
    } catch (e) {
      console.warn('Tumor marker search failed — institution may use different codes', e);
      return {};
    }

    const result = {};
    for (const entry of bundle.entry || []) {
      const obs = entry.resource;
      const code = obs.code?.coding?.find(c => TUMOR_MARKER_CODES[c.code])?.code;
      if (!code) continue;
      const field = TUMOR_MARKER_CODES[code];
      // Most-recent result wins (already sorted -date)
      if (result[field] !== undefined) continue;

      if (field === 'tumorSizeCm') {
        result[field] = obs.valueQuantity?.value ?? null;
      } else {
        // ER/PR/HER2 typically come back as valueCodeableConcept (Positive/Negative)
        const text = (obs.valueCodeableConcept?.text ||
                      obs.valueCodeableConcept?.coding?.[0]?.display ||
                      obs.valueString || '').toLowerCase();
        result[field] = text.includes('positive') ? 'positive'
                        : text.includes('negative') ? 'negative'
                        : text || null;
      }
    }
    return result;
  }

  // ── STEP 5: WRITE STAGING SUMMARY BACK TO THE CHART ──────────────────
  // Creates a DocumentReference resource containing the staging summary
  // (plain text) and the SVG diagram (base64-encoded), attached to the
  // current patient and encounter (if available).
  async function writeStagingNote({ summaryText, svgMarkup, title }) {
    if (!state.patientId) {
      throw new Error('No patient context — cannot write DocumentReference.');
    }

    const svgBase64 = btoa(unescape(encodeURIComponent(svgMarkup)));
    const textBase64 = btoa(unescape(encodeURIComponent(summaryText)));

    const docRef = {
      resourceType: 'DocumentReference',
      status: 'current',
      type: {
        coding: [{
          system: 'http://loinc.org',
          code: '11526-1',          // Pathology study (closest general LOINC; confirm with Epic analyst)
          display: 'Pathology study'
        }],
        text: title || 'Breast Cancer Staging Summary'
      },
      subject: { reference: `Patient/${state.patientId}` },
      ...(state.encounterId ? { context: { encounter: [{ reference: `Encounter/${state.encounterId}` }] } } : {}),
      date: new Date().toISOString(),
      content: [
        {
          attachment: {
            contentType: 'text/plain',
            data: textBase64,
            title: 'TNM Staging Summary'
          }
        },
        {
          attachment: {
            contentType: 'image/svg+xml',
            data: svgBase64,
            title: 'Anatomical Staging Diagram'
          }
        }
      ]
    };

    return fhirPost('DocumentReference', docRef);
  }

  return {
    launch,
    handleRedirect,
    restoreSession,
    getPatient,
    getTumorMarkers,
    writeStagingNote,
    get isAuthenticated() { return !!state.accessToken; },
    get patientId() { return state.patientId; }
  };
})();
