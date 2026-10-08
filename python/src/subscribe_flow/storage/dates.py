"""Shared calendar projection: facts retain their original precision and timezone."""
import re
from datetime import date, datetime, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from subscribe_flow.contracts import ChannelError


def display_zone(value='UTC'):
    if not isinstance(value, str) or not re.fullmatch(r'[A-Za-z0-9_+./-]{1,100}', value):
        raise ChannelError('INVALID_INPUT', 'content.query', '展示时区无效')
    try:
        return ZoneInfo(value)
    except (ZoneInfoNotFoundError, ValueError) as error:
        raise ChannelError('INVALID_INPUT', 'content.query', '展示时区无效') from error


def calendar_key(value, precision, source_zone, target_zone):
    """SQL filter/group key; date precision is a literal date, never a new fact."""
    if not value or precision == 'unknown':
        return None
    try:
        if precision == 'date' or len(value) == 10:
            day = date.fromisoformat(value[:10])
            return day.isoformat() + 'T00:00:00.000000'
        stamp = datetime.fromisoformat(value.replace('Z', '+00:00'))
        if stamp.tzinfo is None:
            stamp = stamp.replace(tzinfo=ZoneInfo(source_zone or 'UTC'))
        return stamp.astimezone(ZoneInfo(target_zone)).isoformat(timespec='microseconds')[:26]
    except (ValueError, TypeError, ZoneInfoNotFoundError, OverflowError):
        # Legacy or unavailable publication facts stay outside the calendar.
        return None


def calendar_order(value, precision, source_zone, target_zone):
    """Chronological ordering also survives a repeated wall-clock hour at DST end."""
    if not value or precision == 'unknown':
        return None
    try:
        if precision == 'date' or len(value) == 10:
            stamp = datetime.fromisoformat(date.fromisoformat(value[:10]).isoformat()).replace(tzinfo=ZoneInfo(target_zone))
        else:
            stamp = datetime.fromisoformat(value.replace('Z', '+00:00'))
            if stamp.tzinfo is None:
                stamp = stamp.replace(tzinfo=ZoneInfo(source_zone or 'UTC'))
        return stamp.astimezone(timezone.utc).isoformat(timespec='microseconds')
    except (ValueError, TypeError, ZoneInfoNotFoundError, OverflowError):
        return None


def date_boundary(value, *, end=False, zone='UTC'):
    if not isinstance(value, str):
        raise ChannelError('INVALID_INPUT', 'content.query', '日期筛选无效')
    try:
        if re.fullmatch(r'\d{4}-\d{2}-\d{2}', value):
            day = date.fromisoformat(value).isoformat()
            return day + ('T23:59:59.999999' if end else 'T00:00:00.000000')
        stamp = datetime.fromisoformat(value.replace('Z', '+00:00'))
        if stamp.tzinfo is None:
            stamp = stamp.replace(tzinfo=display_zone(zone))
        return stamp.astimezone(display_zone(zone)).isoformat(timespec='microseconds')[:26]
    except (ValueError, OverflowError) as error:
        raise ChannelError('INVALID_INPUT', 'content.query', '日期筛选无效') from error
