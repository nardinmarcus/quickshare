(function () {
  const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;
  const DATE_TIME_LOCAL_PATTERN = /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?$/;

  function format(timestamp) {
    return new Date(Number(timestamp)).toLocaleString('zh-CN', {
      hour12: false,
      timeZone: 'Asia/Shanghai'
    });
  }

  function toDateTimeLocal(timestamp) {
    return new Date(Number(timestamp) + BEIJING_OFFSET_MS).toISOString().slice(0, 23);
  }

  function parseDateTimeLocal(value) {
    if (!DATE_TIME_LOCAL_PATTERN.test(value)) return NaN;

    const timestamp = Date.parse(value + '+08:00');
    return toDateTimeLocal(timestamp).slice(0, value.length) === value ? timestamp : NaN;
  }

  window.AdminTime = {
    format,
    parseDateTimeLocal,
    toDateTimeLocal
  };
})();
