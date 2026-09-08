"""Optional browser smoke test: pip install playwright, then run against the local API."""
import csv
import io
import json
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path

from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / '.artifacts'
OUT.mkdir(exist_ok=True)
BASE = os.environ.get('DASHBOARD_TEST_URL', 'http://127.0.0.1:5000')


def csv_download(page, button):
    with page.expect_download() as download:
        button.click()
    file = download.value
    target = OUT / file.suggested_filename
    file.save_as(target)
    return list(csv.DictReader(io.StringIO(target.read_text(encoding='utf-8-sig'))))


def no_overflow(page):
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'Page overflows viewport'


with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    context = browser.new_context(viewport={'width': 1440, 'height': 1060}, timezone_id='Asia/Kolkata')
    page = context.new_page()
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto(BASE + '/?demo=1', wait_until='networkidle')
    expect(page.locator('h1')).to_contain_text('community')
    expect(page.locator('#sourceLabel')).to_have_text('Sample workspace')
    page.screenshot(path=str(OUT / 'overview-desktop.png'), full_page=True)
    no_overflow(page)

    page.locator('nav [data-page="members"]').click()
    page.locator('#memberSearch').fill('saanvi')
    expect(page.locator('tbody tr')).to_have_count(1)
    page.locator('tbody a.member-cell').click()
    expect(page.locator('h1')).to_have_text('saanvi')
    rows = csv_download(page, page.locator('main [data-action="export"]'))
    assert len(rows) == 1 and rows[0]['username'] == 'saanvi'
    assert rows[0]['user_id'] == '1000000000000000001'
    page.screenshot(path=str(OUT / 'member-desktop.png'), full_page=True)

    page.locator('#globalSearch').fill('mira')
    page.locator('#globalSearch').press('Enter')
    expect(page.locator('h1')).to_have_text('mira.jpg')

    page.locator('nav [data-page="channels"]').click()
    page.locator('tbody a.channel-name').first.click()
    expect(page.locator('h1')).to_contain_text('#')
    rows = csv_download(page, page.locator('main [data-action="export"]'))
    assert len({r['channel_id'] for r in rows}) == 1
    assert all(r['event_type'] != 'presence' for r in rows)

    page.locator('nav [data-page="activity"]').click()
    page.locator('#eventType').select_option('reaction')
    expect(page.locator('tbody .tag').first).to_have_text('Reaction')
    rows = csv_download(page, page.locator('main [data-action="export"]'))
    assert len(rows) > 20 and all(r['event_type'] == 'reaction' for r in rows)
    before = page.locator('tbody tr').first.inner_text()
    page.locator('[data-action="event-page"][data-value="2"]').click()
    assert page.locator('tbody tr').first.inner_text() != before
    page.locator('#eventSearch').fill('no-such-user')
    expect(page.locator('main')).to_contain_text('Nothing in this window.')

    page.locator('nav [data-page="reports"]').click()
    page.locator('[data-action="report-type"][data-value="member"]').click()
    page.locator('#reportUser').select_option('1000000000000000001')
    expect(page.locator('.report-preview tbody tr')).to_have_count(1)
    rows = csv_download(page, page.locator('main .report-actions [data-action="export"]'))
    assert len(rows) == 1 and rows[0]['username'] == 'saanvi'
    with page.expect_download() as download:
        page.locator('[data-action="json"]').click()
    report_file = OUT / 'member-report.json'
    download.value.save_as(report_file)
    report = json.loads(report_file.read_text())
    assert report['source'] == 'sample' and len(report['rows']) == 1
    page.pdf(path=str(OUT / 'member-report.pdf'), print_background=True, format='A4')
    page.screenshot(path=str(OUT / 'reports-desktop.png'), full_page=True)

    page.locator('[data-action="custom-range"]').click()
    page.locator('#rangeFrom').fill('2026-10-20')
    page.locator('#rangeTo').fill('2026-10-19')
    page.locator('#rangeForm button[type="submit"]').click()
    expect(page.locator('#rangeError')).to_contain_text('on or after')
    today = datetime.now(timezone.utc).date()
    page.locator('#rangeFrom').fill((today - timedelta(days=6)).isoformat())
    page.locator('#rangeTo').fill(today.isoformat())
    page.locator('#rangeForm button[type="submit"]').click()
    expect(page.locator('#rangeDialog')).not_to_be_visible()
    expect(page.locator('[data-action="custom-range"]')).to_have_attribute('aria-pressed', 'true')
    page.locator('#timezoneSelect').select_option('0')
    expect(page.locator('.report-masthead p')).to_contain_text('UTC')

    # Actual sparse SQLite data, without modifying it.
    page.locator('.settings-button').click()
    page.locator('#apiUrl').fill(BASE)
    page.locator('#serverName').fill('Local community')
    page.locator('#apiToken').fill('')
    page.locator('#connectSubmit').click()
    expect(page.locator('#sourceLabel')).to_have_text('API connected')
    page.locator('nav [data-page="overview"]').click()
    page.locator('[data-action="period"][data-value="14"]').click()
    expect(page.locator('#sourceLabel')).to_have_text('API connected')
    guild = page.locator('#guildSelect').input_value()
    live_response = page.request.get(BASE + '/api/snapshot?guild_id=' + guild)
    assert live_response.ok, 'The browser check needs a complete, small local dataset'
    live_snapshot = live_response.json()
    period_end = datetime.combine(datetime.now(timezone.utc).date() + timedelta(days=1), datetime.min.time(), timezone.utc)
    expected_presence = sum(datetime.fromisoformat(row['timestamp'].replace('Z', '+00:00')) < period_end for row in live_snapshot['presence_logs'])
    page.locator('[data-action="period"][data-value="all"]').click()
    expect(page.locator('.kpi-value').nth(3)).to_have_text(f'{expected_presence:,}')
    page.screenshot(path=str(OUT / 'real-data-desktop.png'), full_page=True)

    # A broken real connection must never become fake live data.
    page.route('**/api/*', lambda route: route.abort())
    page.locator('.sync-button').click()
    expect(page.locator('.banner.error')).to_be_visible()
    expect(page.locator('#sourceLabel')).to_have_text('Connection interrupted')
    assert 'Sample workspace' not in page.locator('#sourceLabel').inner_text()
    page.unroute('**/api/*')
    page.locator('.sync-button').click()
    expect(page.locator('#sourceLabel')).to_have_text('API connected')

    for width in [390, 768, 1024]:
        mobile = browser.new_context(viewport={'width': width, 'height': 844}, timezone_id='Asia/Kolkata')
        view = mobile.new_page()
        view.on('pageerror', lambda error: errors.append(str(error)))
        view.goto(BASE + '/?demo=1', wait_until='networkidle')
        expect(view.locator('h1')).to_be_visible()
        no_overflow(view)
        if width == 390:
            view.screenshot(path=str(OUT / 'overview-mobile.png'), full_page=True)
        for route in ['members', 'channels', 'activity', 'reports']:
            view.goto(BASE + '/?demo=1#' + route, wait_until='networkidle')
            expect(view.locator('h1')).to_be_visible()
            no_overflow(view)
        if width == 390:
            view.locator('.mobile-menu').click()
            expect(view.locator('#sidebar')).to_have_class('sidebar open')
            view.locator('nav [data-page="members"]').click()
            expect(view.locator('#sidebar')).to_have_class('sidebar')
        mobile.close()

    assert not errors, errors
    print(json.dumps({'browser': 'Chromium', 'javascript_errors': errors,
        'viewports': [390, 768, 1024, 1440], 'checked': ['overview', 'member search and reports',
        'global search', 'channel drilldown', 'event filters and pagination', 'CSV and JSON downloads',
        'print PDF', 'custom ranges', 'timezone', 'real SQLite', 'connection failure and recovery',
        'mobile navigation', 'responsive overflow'], 'artifacts': str(OUT)}, indent=2))
    browser.close()
