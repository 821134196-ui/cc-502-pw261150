// @vitest-environment happy-dom
import React from 'react';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import App from '../src/App.jsx';
import { createApp, createDb } from '../server/api.js';

let server;
let base;

beforeAll(async () => {
  const db = createDb(':memory:');
  const app = createApp(db);
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  base = `http://localhost:${server.address().port}`;
  const nodeFetch = globalThis.fetch;
  globalThis.fetch = (url, opts) => nodeFetch(String(url).startsWith('/') ? base + url : url, opts);
  window.localStorage.clear();
});

afterEach(() => cleanup());

afterAll(async () => {
  // Let in-flight useAsync fetches settle so teardown doesn't log ECONNRESET.
  await new Promise((r) => setTimeout(r, 250));
  server?.close();
});

function renderAt(path) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}

describe('console rendering', () => {
  it('renders the overview with contracts and active incidents', async () => {
    renderAt('/');
    await waitFor(() => expect(screen.getByText('Reliability overview')).toBeTruthy());
    await waitFor(() => expect(screen.getAllByText('Revenue Daily Integrity').length).toBeGreaterThan(0));
    expect(screen.getAllByText('Active incidents').length).toBeGreaterThan(0);
    await waitFor(() => expect(screen.getAllByText(/below 98.50% target/).length).toBeGreaterThan(0));
  });

  it('renders the SLO list with rule versions and states', async () => {
    renderAt('/slos');
    await waitFor(() => expect(screen.getByText('SLO contracts')).toBeTruthy());
    await waitFor(() => expect(screen.getByText('Orders Clean Contract')).toBeTruthy());
    const table = screen.getByRole('table');
    expect(within(table).getAllByText(/^v\d$/).length).toBeGreaterThan(0);
  });

  it('renders SLO detail with evidence and rule history', async () => {
    renderAt('/slos/slo-revenue');
    await waitFor(() => expect(screen.getAllByText('Revenue Daily Integrity').length).toBeGreaterThan(0));
    expect(await screen.findByText(/Composite score trend|Rolling score vs target/)).toBeTruthy();
    expect(screen.getByText('Dimension evidence')).toBeTruthy();
    expect(screen.getByText('Trend & evidence')).toBeTruthy();
    expect(screen.getByText(/Rule versions/)).toBeTruthy();
  });

  it('renders the alert console and opens the lifecycle drawer', async () => {
    renderAt('/alerts');
    await waitFor(() => expect(screen.getByText('Alert lifecycle')).toBeTruthy());
    await waitFor(() => expect(screen.getAllByText(/below 98.50% target/).length).toBeGreaterThan(0));
    const trigger = screen.getAllByText(/#\d+ · slo-/)[0];
    trigger.closest('button').click();
    await waitFor(() => expect(screen.getByText('Lifecycle events')).toBeTruthy());
    expect(within(screen.getByRole('dialog')).getByText('Opened')).toBeTruthy();
  });

  it('renders lineage impact without mutating history', async () => {
    renderAt('/lineage');
    await waitFor(() => expect(screen.getByText('Lineage & impact')).toBeTruthy());
    await waitFor(() => expect(screen.getByText('Contract impact')).toBeTruthy());
    expect(screen.getByText('Assets exposed')).toBeTruthy();
  });

  it('renders the revision ledger and the scenario lab', async () => {
    renderAt('/revisions');
    await waitFor(() => expect(screen.getByText('Metric revisions')).toBeTruthy());
    expect(screen.getByText('New correction')).toBeTruthy();
    // The seeded correction is in the ledger, not an empty state.
    await waitFor(() => expect(screen.getAllByText(/staging\.orders_clean/).length).toBeGreaterThan(0));
    expect(screen.getByText('Ledger')).toBeTruthy();

    renderAt('/scenarios');
    await waitFor(() => expect(screen.getByText('Verification lab')).toBeTruthy());
    expect(screen.getByText('Upstream gap → backfill')).toBeTruthy();
    expect(screen.getByText('Run history')).toBeTruthy();
  });

  it('renders governance registries', async () => {
    renderAt('/governance');
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Governance' })).toBeTruthy());
    expect(screen.getByText('Rule version registry')).toBeTruthy();
    expect(screen.getByText('Audit log')).toBeTruthy();
    expect(screen.getByText('Maintenance windows')).toBeTruthy();
    // An exemption pinned to a rule shows the human version, not the row id.
    await waitFor(() => expect(screen.getByText('slo-orders')).toBeTruthy());
    const row = screen.getByText('slo-orders').closest('tr');
    expect(within(row).getByText('v1')).toBeTruthy();
    expect(within(row).queryByText(/^#\d+$/)).toBeNull();
  });
});
