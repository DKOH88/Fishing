    // ==================== CONFIG ====================
    function safeMin(arr) { return arr.reduce((m, v) => v < m ? v : m, Infinity); }
    function safeMax(arr) { return arr.reduce((m, v) => v > m ? v : m, -Infinity); }
    /** 현재 시각을 KST(UTC+9) Date 객체로 반환 — Date 산술용 (시간차 비교 등) */
    function getNowKST() { return new Date(Date.now() + 9 * 60 * 60 * 1000); }
    /** KST 오늘 날짜를 'YYYY-MM-DD' 형식으로 반환 (Intl 기반, 서머타임 안전) */
    function getKSTDateStr() { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date()); }
    /** KST 현재 시각을 10분 단위 라운드 스냅하여 'HH:MM' 라벨로 반환 */
    function getKSTTimeLabel() {
        const now = getNowKST();
        const snapped = Math.round((now.getUTCHours() * 60 + now.getUTCMinutes()) / 10) * 10;
        return String(Math.floor(snapped / 60)).padStart(2, '0') + ':' + String(snapped % 60).padStart(2, '0');
    }
    const API_BASE = 'https://tide-api-proxy.odk297.workers.dev';

    // ==================== 방문자 카운터 ====================
    async function loadVisitorCount() {
        try {
            const r = await fetch(`${API_BASE}/api/visitor`);
            if (!r.ok) return;
            const d = await r.json();
            const el = document.getElementById('visitorCounter');
            if (el && d.today != null && d.total != null) {
                el.textContent = `Today: ${d.today.toLocaleString()}명 · Total: ${d.total.toLocaleString()}명`;
            }
        } catch(e) { /* 방문자 카운터 실패 시 무시 */ }
    }

    let tideChart = null;
    let currentChart = null;
    let combinedChart = null;
    let tideChartReloading = false;
    let currentSpeedUnit = 'cm/s';
    let currentViewState = { items: [], el: null, fldEbbSummary: null, areaSummary: null };
    const CMPS_PER_KNOT = 51.444444;

    // #18+#19: fetchAll 중복 호출/타임아웃 시 in-flight 요청 취소용
    let _fetchAllController = null;

    // ==================== 앱 상태 변수 (window.* → 모듈 스코프) ====================
    let _selectedPort = null;
    let _weatherInfo = null;
    let _dischargePrefetch = null;
    let _dischargeLoaded = false;
    let _dischargeData = null;
    let _lastMulddaePct = null;
    let _fishingIndexInfo = null;
    let _chartData = null;
    let _hlData = null;
    let _sunTimes = null;
    let _zoneData = [];

    // ==================== 지역 데이터 (관측소 + 조류 예보점 통합) ====================
    const REGIONS = [
        {
            key: 'incheon', label: '인천/경기',
            stations: [
                ['DT_0001','인천'],['DT_0052','인천송도'],['DT_0044','영종대교'],['DT_0032','강화대교'],
                ['DT_0043','영흥도'],['DT_0093','소무의도'],['DT_0065','덕적도'],['DT_0066','향화도'],
                ['DT_0002','평택'],['DT_0008','안산']
            ],
            currents: [
                ['07GG03','석모수도'],['07GG06','인천갑문'],['07GG11','덕적도'],['09IC01','인천남항'],
                ['09IC07','경인아라뱃길'],['14IC03','자월도북측'],['14IC04','이작도서측'],['16LTC01','인천대교'],
                ['16LTC02','인천동수도입구'],['16DJ04','시화방조제'],['17LTC01','인천신항입구'],['17LTC02','경기만북수도'],
                ['19LTC01','화성방조제'],['20LTC04','영흥도서측'],['20LTC07','자월도북서측'],['20LTC11','덕적군도서측'],
                ['20LTC12','수우도서측'],['05GH-5','장봉수도'],['15LTC01','염하수도'],['03DS-1','장안서']
            ]
        },
        {
            key: 'west_mid', label: '충남/전북(서해중부)',
            stations: [
                ['DT_0050','태안'],['DT_0067','안흥'],['DT_0017','대산'],['DT_0025','보령'],
                ['DT_0051','서천마량'],['DT_0024','장항'],['DT_0018','군산'],['DT_0068','위도'],['DT_0037','어청도']
            ],
            currents: [
                ['03PT-1','아산만입구'],['07DS02','대산항'],['07TA03','태안'],['07TA04','만리포'],
                ['07TA05','안흥'],['07TA09','격렬비열도'],['07KS01','원산도'],['07KS03','외연열도'],
                ['12JB11','비인만'],['12JB14','군산항입구'],['13PT01','평택항'],['15LTC08','장고도수도'],
                ['16LTC03','천수만'],['17LTC04','문갑도동측'],['17LTC06','가로림만입구'],['19LTC02','외연도동측'],
                ['23GA01','안면도서측'],['24TJ02','가로림만'],['24TJ04','입파도'],['24TJ05','아산만28호등부표']
            ]
        },
        {
            key: 'west_south', label: '전남서부(목포/신안)',
            stations: [
                ['DT_0007','목포'],['DT_0035','흑산도'],['DT_0094','서거차도']
            ],
            currents: [
                ['01MP-2','목포구'],['06SA01','면도수도'],['06SA10','팔구포북측'],['06SA18','경치동수도'],
                ['06GS07','고군산군도'],['07JB12','수도수도북측'],['07JB14','수도수도'],['10MP07','시아해'],
                ['14BP01','병풍도북측'],['15LTC02','어청도서측'],['15LTC03','위도동측'],['16LTC05','목포북항북측'],
                ['16LTC06','시아해북측'],['17LTC08','녹도북측'],['17LTC09','십이동파도'],['17LTC10','고군산군도북측'],
                ['17MTC14','위도서측'],['17MTC19','안마도서측'],['17MTC20','안마도동측'],['18LTC01','난지도북측'],
                ['18LTC02','와도서측'],['18LTC03','안좌도북측'],['18LTC04','비금수도'],['19LTC03','재원동수도'],
                ['19LTC04','증도동측'],['19LTC05','매화도서측'],['19LTC06','하의수도'],['20LTC01','어불도서측'],
                ['20LTC02','독거군도북측'],['20LTC03','외모군도남측'],['20LTC05','함평만입구'],['20LTC08','우이수도'],
                ['20LTC09','송이도북측'],['22LTC12','마량항'],['22EW01','대화사도서측'],['23LTC05','율도북동측'],
                ['23LTC06','대야도동측'],['23LTC07','우이도남측'],['23LTC08','장산도서측'],['23LTC09','달리도서측'],
                ['24LTC01','재원도남서측'],['24LTC02','어의도북측'],['24LTC03','안마도남측'],['24LTC04','거륜도남서측'],
                ['24LTC05','말도남측'],['24LTC06','소횡경도북측'],['24LTC07','십이동파도남동측'],['24LTC08','대화사도남측'],
                ['24LTC09','삽시도북측'],['24LTC10','외파수도남측'],['24LTC11','가의도북동측']
            ]
        },
        {
            key: 'south_west', label: '전남동부(진도/완도/여수)',
            stations: [
                ['DT_0028','진도'],['DT_0027','완도'],['DT_0026','고흥발포'],['DT_0092','여호항'],
                ['DT_0016','여수'],['DT_0049','광양'],['DT_0031','거문도']
            ],
            currents: [
                ['06JD01','외병도'],['06GH01','득량만입구'],['06GH07','거금도남측'],['06YME1','광도동측'],
                ['06YME4','보길도남서측'],['06YME5','장죽수도'],['06YME6','맹골수도'],['06YME8','매물수도'],
                ['06YS03','신강수도'],['06YS04','서수도(여자만)'],['06YS09','거금수도'],['08GY-5','묘도수도'],
                ['11JD02','정등해'],['11JD09','마로해'],['12YS08','광양항'],['13WD01','소안도'],
                ['14JD03','정등해북측'],['15LTC05','만재도서측'],['15LTC06','거차수도'],['15LTC07','독거군도동측'],
                ['15LTC09','금당수도'],['15LTC10','여수해만'],['15SE01','노량수도'],['15HD05','하동항'],
                ['16LTC04','역도'],['16LTC07','장산도동측'],['16LTC08','광양항제1항로'],['16LTC12','낙동포'],
                ['17LTC11','가사도동측'],['17LTC12','소안수도'],['17LTC13','완도통항분리대'],['18LTC05','흑일도남측'],
                ['18LTC06','여수해협'],['18LTC07','여수해만입구'],['18MTC10','초도남측'],['19LTC07','청산도동측'],
                ['19LTC08','대병풍도서측'],['19LTC09','초도동측'],['19LTC10','손죽도북측'],['19LTC11','나로도동측'],
                ['19LTC12','여수해만남측'],['19LTC13','대병대도동측'],['20LTC06','금오열도남측'],['20LTC13','관리도'],
                ['20LTC14','가덕도남측'],['20LTC15','거금도동측'],['22LTC01','삼천포-제주항로'],['22LTC02','대방수도'],
                ['22LTC03','노량수도동측'],['22LTC04','외수도'],['22LTC05','금오수도'],['22LTC06','백야도동측'],
                ['22LTC07','백야수도'],['22LTC08','외나로도서측'],['22LTC09','손죽도서측'],['22LTC10','소록도동측'],
                ['22LTC13','청산도서측'],['22LTC14','황제도동측'],['22LTC15','광양항A호등부표'],
                ['23LTC01','우도북서측'],['23LTC02','제주도서측'],['23LTC03','백일도동측'],['23LTC04','어룡도북측'],
                ['23YG03','외나로도남측']
            ]
        },
        {
            key: 'south_east', label: '경남(통영/거제/부산)',
            stations: [
                ['DT_0061','삼천포'],['DT_0014','통영'],['DT_0029','거제도'],['DT_0063','가덕도'],
                ['DT_0062','마산'],['DT_0056','부산항신항'],['DT_0005','부산']
            ],
            currents: [
                ['01SR-1','사량도북측'],['08GA01','감천항입구'],['10GD03','가덕수도'],['16LTC09','통영해만'],
                ['16LTC10','비진도남측'],['16LTC13','부산항입구'],['16MTC01','미조수도'],['16MTC16','지심도서측'],
                ['17LTC14','욕지도북측'],['18LTC08','두미도북측'],['18LTC09','사량도동측'],['18LTC10','가조도수도'],
                ['18LTC11','진해만(통영항로)'],['18LTC12','거제도동측'],['18LTC13','해운대'],['19LTC14','광안리'],
                ['21LTC01','태종대남측'],['21LTC02','북형제도남측'],['21LTC03','가덕도남서측'],['21LTC04','부산항신항'],
                ['21LTC05','저도서측'],['21LTC06','내도동측'],['21LTC07','칠천도북서측'],['21LTC08','장사도북측'],
                ['21LTC09','용초도북측'],['21LTC10','견내량해협'],['21LTC11','오곡도북측'],['21LTC12','곤리도남측'],
                ['21LTC13','사량도북동측'],['21LTC14','신수도동측'],['98HG-1','횡간수도']
            ]
        },
        {
            key: 'east', label: '동해',
            stations: [
                ['DT_0020','울산'],['DT_0091','포항'],['DT_0039','왕돌초'],['DT_0011','후포'],
                ['DT_0057','동해항'],['DT_0006','묵호'],['DT_0012','속초'],['DT_0013','울릉도']
            ],
            currents: [
                ['16LTC14','울산신항'],['17LTC05','울도'],['17LTC07','울도남측'],['18LTC14','대왕암남측']
            ]
        },
        {
            key: 'jeju', label: '제주',
            stations: [
                ['DT_0004','제주'],['DT_0022','성산포'],['DT_0010','서귀포'],['DT_0023','모슬포'],['DT_0021','추자도']
            ],
            currents: [
                ['02JJ-1','제주항'],['08JJ03','성산포'],['08JJ07','서귀포'],['08JJ13','애월항북측'],
                ['08F','추자도남서측'],['10ED01','이어도'],['22MTC03','제주해협']
            ]
        },
        {
            key: 'ocean_base', label: '해양과학기지',
            stations: [
                ['DT_0042','교본초'],['IE_0060','이어도'],['IE_0061','신안가거초'],['IE_0062','옹진소청초']
            ],
            currents: []
        }
    ];

    // ==================== 낚시 포인트 프리셋 (가장 가까운 관측소/조류예보점 매핑) ====================
    const FISHING_PORTS = [
        { name: '오천항', lat: 36.38, lon: 126.47, region: '충남', station: 'DT_0025', stationName: '보령', current: '16LTC03', currentName: '천수만', wxLat: 36.4393, wxLon: 126.5196 },
        { name: '삼길포항', lat: 37.00, lon: 126.45, region: '충남', station: 'DT_0017', stationName: '대산', current: '07DS02', currentName: '대산항', wxLat: 37.0035, wxLon: 126.4528 },
        { name: '대천항', lat: 36.32, lon: 126.51, region: '충남', station: 'DT_0025', stationName: '보령', current: '07KS01', currentName: '원산도', wxLat: 36.3276, wxLon: 126.5123 },
        { name: '홍원항', lat: 36.30, lon: 126.48, region: '충남', station: 'DT_0051', stationName: '서천마량', current: '12JB11', currentName: '비인만', wxLat: 36.1563, wxLon: 126.5017 },
        { name: '무창포', lat: 36.27, lon: 126.54, region: '충남', station: 'DT_0025', stationName: '보령', current: '07KS01', currentName: '원산도', wxLat: 36.2489, wxLon: 126.5370 },
        { name: '신진도항', lat: 36.50, lon: 126.30, region: '충남', station: 'DT_0067', stationName: '안흥', current: '07TA05', currentName: '안흥' },
        { name: '마검포항', lat: 36.41, lon: 126.33, region: '충남', station: 'DT_0025', stationName: '보령', current: '23GA01', currentName: '안면도서측', wxLat: 36.6224, wxLon: 126.2852 },
        { name: '영목항', lat: 36.38, lon: 126.32, region: '충남', station: 'DT_0025', stationName: '보령', current: '16LTC03', currentName: '천수만', wxLat: 36.3997, wxLon: 126.4276 },
        { name: '구매항', lat: 36.50, lon: 126.27, region: '충남', station: 'DT_0025', stationName: '보령', current: '16LTC03', currentName: '천수만', wxLat: 36.4249, wxLon: 126.4331 },
        { name: '안흥외항', lat: 36.67, lon: 126.13, region: '충남', station: 'DT_0067', stationName: '안흥', current: '07TA05', currentName: '안흥', wxLat: 36.6791, wxLon: 126.1531 },
        { name: '남당항', lat: 36.53, lon: 126.44, region: '충남', station: 'DT_0025', stationName: '보령', current: '16LTC03', currentName: '천수만', wxLat: 36.5369, wxLon: 126.4689 },
        { name: '대야도', lat: 36.38, lon: 126.50, region: '충남', station: 'DT_0025', stationName: '보령', current: '16LTC03', currentName: '천수만', wxLat: 36.4673, wxLon: 126.4160 },
        { name: '간월도', lat: 36.62, lon: 126.37, region: '충남', station: 'DT_0017', stationName: '대산', current: '17LTC06', currentName: '가로림만입구' },
        { name: '궁리포구', lat: 36.78, lon: 126.12, region: '충남', station: 'DT_0050', stationName: '태안', current: '07TA03', currentName: '태안' },
        { name: '격포항', lat: 35.62, lon: 126.47, region: '전북', station: 'DT_0068', stationName: '위도', current: '15LTC03', currentName: '위도동측' },
        { name: '부안변산', lat: 35.67, lon: 126.51, region: '전북', station: 'DT_0068', stationName: '위도', current: '15LTC03', currentName: '위도동측' },
        { name: '비응항', lat: 35.97, lon: 126.62, region: '전북', station: 'DT_0018', stationName: '군산', current: '12JB14', currentName: '군산항입구' },
        { name: '선유도', lat: 35.82, lon: 126.42, region: '전북', station: 'DT_0018', stationName: '군산', current: '06GS07', currentName: '고군산군도' },
        { name: '녹동항', lat: 34.48, lon: 127.08, region: '전남', station: 'DT_0026', stationName: '고흥발포', current: '06YS09', currentName: '거금수도', wxLat: 34.5231, wxLon: 127.1436 },
        { name: '마량항', lat: 34.38, lon: 126.38, region: '전남', station: 'DT_0031', stationName: '진도', current: '22LTC12', currentName: '마량항' },
        { name: '하효항', lat: 33.23, lon: 126.58, region: '제주', station: 'DT_0010', stationName: '서귀포', current: '08JJ07', currentName: '서귀포' },
        { name: '김녕항', lat: 33.55, lon: 126.77, region: '제주', station: 'DT_0022', stationName: '성산포', current: '08JJ03', currentName: '성산포' },
        { name: '한림항', lat: 33.42, lon: 126.27, region: '제주', station: 'DT_0023', stationName: '모슬포', current: '08JJ13', currentName: '애월항북측' },
        { name: '대포항', lat: 35.16, lon: 129.18, region: '경남', station: 'DT_0005', stationName: '부산', current: '18LTC13', currentName: '해운대' },
        { name: '구룡포항', lat: 35.98, lon: 129.57, region: '경북', station: 'DT_0091', stationName: '포항', current: '17LTC05', currentName: '울도' },
        { name: '축산항', lat: 36.43, lon: 129.45, region: '경북', station: 'DT_0011', stationName: '후포', current: '17LTC07', currentName: '울도남측' },
        { name: '장호항', lat: 37.28, lon: 129.33, region: '강원', station: 'DT_0057', stationName: '동해항', current: null, currentName: null },
        { name: '임원항', lat: 37.25, lon: 129.35, region: '강원', station: 'DT_0057', stationName: '동해항', current: null, currentName: null },
        { name: '백사장항', lat: 36.59, lon: 126.31, region: '충남', station: 'DT_0067', stationName: '안흥', current: '23GA01', currentName: '안면도서측', wxLat: 36.5864, wxLon: 126.3181 },
        { name: '전곡항', lat: 37.15, lon: 126.66, region: '경기', station: 'DT_0008', stationName: '안산', current: '19LTC01', currentName: '화성방조제', wxLat: 37.1876, wxLon: 126.6504 },
        { name: '영흥도', lat: 37.25, lon: 126.47, region: '인천', station: 'DT_0043', stationName: '영흥도', current: '20LTC04', currentName: '영흥도서측', wxLat: 37.2630, wxLon: 126.4649 },
    ];
    _selectedPort = null;

    // ==================== 관측소/조류 연동 ====================
    function getRegionByStationCode(code) {
        for (const r of REGIONS) {
            if (r.stations.some(s => s[0] === code)) return r;
        }
        return REGIONS[0];
    }

    function getRegionByCurrentCode(code) {
        for (const r of REGIONS) {
            if (r.currents.some(c => c[0] === code)) return r;
        }
        return null;
    }

    function buildStationSelect() {
        const sel = document.getElementById('stationSelect');
        sel.innerHTML = '';
        for (const r of REGIONS) {
            const og = document.createElement('optgroup');
            og.label = r.label;
            for (const [code, name] of r.stations) {
                const opt = document.createElement('option');
                opt.value = code; opt.textContent = name;
                og.appendChild(opt);
            }
            sel.appendChild(og);
        }
    }

    function buildCurrentSelect(region) {
        const sel = document.getElementById('currentSelect');
        sel.innerHTML = '';
        if (!region || region.currents.length === 0) {
            const opt = document.createElement('option');
            opt.value = ''; opt.textContent = '(이 지역에 조류 예보점 없음)';
            sel.appendChild(opt);
            return;
        }
        const og = document.createElement('optgroup');
        og.label = region.label;
        for (const [code, name] of region.currents) {
            const opt = document.createElement('option');
            opt.value = code; opt.textContent = name;
            og.appendChild(opt);
        }
        sel.appendChild(og);
    }

    function updateRegionBadges(region) {
        document.getElementById('stationRegion').textContent = region.label;
        document.getElementById('currentRegion').textContent = region.label;
    }

    function onStationChange() {
        const code = document.getElementById('stationSelect').value;
        const region = getRegionByStationCode(code);
        buildCurrentSelect(region);
        updateRegionBadges(region);
    }

    // ==================== 검색 기능 ====================
    function buildSearchIndex() {
        const index = [];
        for (const r of REGIONS) {
            for (const [code, name] of r.stations) {
                index.push({ type: 'obs', code, name, region: r, regionLabel: r.label });
            }
            for (const [code, name] of r.currents) {
                index.push({ type: 'crnt', code, name, region: r, regionLabel: r.label });
            }
        }
        // 낚시 포인트 프리셋 추가
        for (const port of FISHING_PORTS) {
            index.push({ type: 'port', name: port.name, lat: port.lat, lon: port.lon, regionLabel: port.region });
        }
        return index;
    }

    const searchIndex = buildSearchIndex();

    function focusAndClearSearchInput(evt) {
        const searchInput = document.getElementById('searchInput');
        const searchResults = document.getElementById('searchResults');
        if (!searchInput) return;

        const clickedSearchResult = !!(evt && evt.target && evt.target.closest && evt.target.closest('.search-results'));
        const isPrefilled = searchInput.dataset.prefilled === '1';
        if (!clickedSearchResult && isPrefilled) {
            searchInput.value = '';
            searchInput.dataset.prefilled = '0';
            if (searchResults) searchResults.classList.remove('show');
        }
        searchInput.focus();
    }

    // HTML escape 유틸 — XSS 방지
    function escapeHTML(str) {
        if (typeof str !== 'string') return '';
        return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
    }

    function doSearch(query) {
        const q = query.trim().toLowerCase().substring(0, 100);
        if (!q) return [];
        return searchIndex.filter(item =>
            item.name.toLowerCase().includes(q) ||
            item.regionLabel.toLowerCase().includes(q) ||
            (item.code && item.code.toLowerCase().includes(q))
        ).sort((a, b) => {
            const aName = a.name.toLowerCase();
            const bName = b.name.toLowerCase();
            const aExact = aName === q;
            const bExact = bName === q;
            if (aExact !== bExact) return aExact ? -1 : 1;
            const aStarts = aName.startsWith(q);
            const bStarts = bName.startsWith(q);
            if (aStarts !== bStarts) return aStarts ? -1 : 1;
            const aIncludes = aName.includes(q);
            const bIncludes = bName.includes(q);
            if (aIncludes !== bIncludes) return aIncludes ? -1 : 1;
            return 0;
        }).slice(0, 15);
    }

    function highlightMatch(text, query) {
        const safe = escapeHTML(text);
        const safeQ = escapeHTML(query);
        const idx = safe.toLowerCase().indexOf(safeQ.toLowerCase());
        if (idx < 0) return safe;
        return safe.substring(0, idx) + '<em>' + safe.substring(idx, idx + safeQ.length) + '</em>' + safe.substring(idx + safeQ.length);
    }

    function renderSearchResults(results, query) {
        const el = document.getElementById('searchResults');
        if (results.length === 0) {
            el.innerHTML = '<div class="search-no-result">검색 결과가 없습니다</div>';
            el.classList.add('show');
            return;
        }
        el.innerHTML = results.map((item, i) => {
            const typeLabel = item.type === 'obs' ? '관측소' : item.type === 'crnt' ? '조류예보점' : '📍 낚시포인트';
            const typeClass = item.type === 'port' ? 'crnt' : item.type;
            return `
            <div class="search-result-item" data-idx="${i}">
                <div class="name">${highlightMatch(item.name, query)}</div>
                <div class="tags">
                    <span class="tag ${typeClass}">${typeLabel}</span>
                    <span class="tag region">${item.regionLabel}</span>
                </div>
            </div>`;
        }).join('');
        el.classList.add('show');

        el.querySelectorAll('.search-result-item').forEach(div => {
            div.addEventListener('click', () => {
                const idx = parseInt(div.dataset.idx);
                selectSearchResult(results[idx]);
            });
        });
    }

    // ==================== 날씨 아이콘 (기상청 단기예보) ====================

    // 위경도 → 기상청 격자좌표 변환 (Lambert Conformal Conic)
    function latLonToGrid(lat, lon) {
        const RE = 6371.00877, GRID = 5.0, SLAT1 = 30.0, SLAT2 = 60.0;
        const OLON = 126.0, OLAT = 38.0, XO = 43, YO = 136;
        const DEGRAD = Math.PI / 180.0;
        const re = RE / GRID;
        const slat1 = SLAT1 * DEGRAD, slat2 = SLAT2 * DEGRAD;
        const olon = OLON * DEGRAD, olat = OLAT * DEGRAD;
        let sn = Math.tan(Math.PI * 0.25 + slat2 * 0.5) / Math.tan(Math.PI * 0.25 + slat1 * 0.5);
        sn = Math.log(Math.cos(slat1) / Math.cos(slat2)) / Math.log(sn);
        let sf = Math.tan(Math.PI * 0.25 + slat1 * 0.5);
        sf = Math.pow(sf, sn) * Math.cos(slat1) / sn;
        let ro = Math.tan(Math.PI * 0.25 + olat * 0.5);
        ro = re * sf / Math.pow(ro, sn);
        let ra = Math.tan(Math.PI * 0.25 + lat * DEGRAD * 0.5);
        ra = re * sf / Math.pow(ra, sn);
        let theta = lon * DEGRAD - olon;
        if (theta > Math.PI) theta -= 2.0 * Math.PI;
        if (theta < -Math.PI) theta += 2.0 * Math.PI;
        theta *= sn;
        return {
            nx: Math.floor(ra * Math.sin(theta) + XO + 0.5),
            ny: Math.floor(ro - ra * Math.cos(theta) + YO + 0.5)
        };
    }

    // SKY + PTY → SVG 아이콘 파일명 매핑
    function getWeatherIconFile(sky, pty, isNight) {
        // PTY(강수형태)가 우선
        if (pty === '1') return isNight ? 'ModerateRainV2.svg' : '비(낮).svg';           // 비
        if (pty === '2') return 'RainSnowV2.svg';                                        // 비/눈
        if (pty === '3') return 'LightSnowV2.svg';                                       // 눈
        if (pty === '4') return isNight ? 'RainShowersNightV2.svg' : '비(낮).svg';       // 소나기
        // SKY(하늘상태)
        if (sky === '1') return isNight ? 'ClearNightV3.svg' : '맑음(낮).svg';           // 맑음
        if (sky === '3') return isNight ? 'PartlyCloudyNightV2.svg' : '구름많음(낮).svg'; // 구름많음
        if (sky === '4') return isNight ? 'CloudyV3.svg' : '흐림(낮).svg';               // 흐림
        return isNight ? 'ClearNightV3.svg' : '구름조금(낮).svg';
    }

    async function loadWeather() {
        const port = _selectedPort;
        if (!port) return;
        // 날씨용 별도 좌표(wxLat/wxLon)가 있으면 우선 사용 (기상청 동/면 대표좌표)
        const wLat = port.wxLat || port.lat;
        const wLon = port.wxLon || port.lon;
        const { nx, ny } = latLonToGrid(wLat, wLon);

        try {
            const resp = await fetch(`${API_BASE}/api/weather?nx=${nx}&ny=${ny}&lat=${wLat}&lon=${wLon}`);
            if (!resp.ok) throw new Error('API error');
            const data = await resp.json();
            if (!data.sky) { _weatherInfo = null; return; }

            // 주간/야간 판정 (06~18시 주간)
            const hour = data.fcstTime ? parseInt(data.fcstTime.slice(0, 2)) : new Date().getHours();
            const isNight = hour < 6 || hour >= 18;
            const iconFile = getWeatherIconFile(data.sky, data.pty, isNight);

            _weatherInfo = {
                iconFile,
                tmp: data.tmp || '--',
                sky: data.sky,
                pty: data.pty,
                isNight
            };
            // 물때 카드가 이미 렌더된 상태라면 갱신
            if (typeof renderMulddaeCardFromState === 'function') {
                renderMulddaeCardFromState();
            }
        } catch (e) {
            console.warn('[weather] load failed:', e);
            _weatherInfo = null;
        }
    }

    function selectSearchResult(item) {
        const stationSel = document.getElementById('stationSelect');
        const currentSel = document.getElementById('currentSelect');

        if (item.type === 'port') {
            // 낚시 포인트 → 기존 관측소/조류 컨트롤에 연결
            const port = FISHING_PORTS.find(p => p.name === item.name);
            if (!port) return;

            // 관측소 설정
            stationSel.value = port.station;
            const region = getRegionByStationCode(port.station);
            buildCurrentSelect(region);
            updateRegionBadges(region);

            // 조류 예보점 설정
            if (port.current) {
                currentSel.value = port.current;
            }
            _selectedPort = port;

            // 포트 정보 설정 (배너 숨기고 검색바에 표시)
            document.getElementById('portBannerName').textContent = port.name;
            document.getElementById('portBannerStation').textContent = `${port.stationName} (${port.station})`;
            document.getElementById('portBannerCurrent').textContent = port.current ? `${port.currentName} (${port.current})` : '예보점 없음';
            document.getElementById('portBanner').style.display = 'none';
            // 검색바 내부 정보 표시
            document.getElementById('searchPortStation').textContent = `${port.stationName} (${port.station})`;
            document.getElementById('searchPortCurrent').textContent = port.current ? `${port.currentName} (${port.current})` : '예보점 없음';
            document.getElementById('searchPortInfo').style.display = '';

            // 물때/조위 탭으로 전환
            document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
            document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
            document.querySelector('[data-tab="tide"]').classList.add('active');
            document.getElementById('tab-tide').classList.add('active');

            // 검색창 닫기
            document.getElementById('searchInput').value = item.name;
            document.getElementById('searchInput').dataset.prefilled = '1';
            document.getElementById('searchResults').classList.remove('show');

            // 자동 조회
            fetchAll();
            loadWeather();
            return;
        }

        // 해당 지역의 관측소를 첫 번째로 선택
        const region = item.region;
        if (item.type === 'obs') {
            stationSel.value = item.code;
        } else {
            // 조류예보점이면 해당 지역의 첫 번째 관측소 선택
            if (region.stations.length > 0) {
                stationSel.value = region.stations[0][0];
            }
        }
        // 지역에 맞는 조류 예보점 목록 갱신
        buildCurrentSelect(region);
        updateRegionBadges(region);

        if (item.type === 'crnt') {
            currentSel.value = item.code;
        } else if (item.type === 'obs') {
            // 관측소→조류예보점 기본 매핑 (가장 가까운 예보점 수동 지정)
            const OBS_TO_CURRENT = {
                'DT_0001': '17LTC01',  // 인천 → 인천신항입구
                'DT_0002': '13PT01',   // 평택 → 평택항
                'DT_0016': '18LTC06',  // 여수 → 여수해협
                'DT_0043': '20LTC04',  // 영흥도 → 영흥도서측
                'DT_0052': '17LTC01',  // 인천송도 → 인천신항입구
            };
            const mapped = OBS_TO_CURRENT[item.code];
            if (mapped) {
                // 매핑된 예보점이 현재 지역에 없으면 해당 지역으로 전환
                if (!region.currents.some(c => c[0] === mapped)) {
                    const targetRegion = getRegionByCurrentCode(mapped);
                    if (targetRegion) {
                        buildCurrentSelect(targetRegion);
                        updateRegionBadges(targetRegion);
                    }
                }
                currentSel.value = mapped;
            } else {
                // 폴백: 같은 이름의 조류 예보점 자동 매칭 (정확→접두사 순)
                const exact = region.currents.find(c => c[1] === item.name);
                const prefix = !exact && region.currents.find(c => c[1].startsWith(item.name));
                const match = exact || prefix;
                if (match) {
                    currentSel.value = match[0];
                }
            }
        }
        _selectedPort = null;

        // 배너 숨기기
        document.getElementById('portBanner').style.display = 'none';
        document.getElementById('searchPortInfo').style.display = 'none';

        // 검색창 닫기
        document.getElementById('searchInput').value = item.name;
        document.getElementById('searchInput').dataset.prefilled = '1';
        document.getElementById('searchResults').classList.remove('show');

        // 자동 조회
        fetchAll();
    }

    // ==================== INIT ====================
    document.addEventListener('DOMContentLoaded', () => {
        loadVisitorCount();
        document.getElementById('dateInput').value = getKSTDateStr();
        updateDateDisplay();
        document.getElementById('dateInput').addEventListener('change', () => { updateDateDisplay(); fetchAll(); });

        // 관측소/조류 연동 초기화
        buildStationSelect();
        onStationChange();
        document.getElementById('stationSelect').addEventListener('change', onStationChange);

        // 기본값: 오천항
        let initialFetchTriggered = false;
        const defaultPort = FISHING_PORTS.find(p => p.name === '오천항');
        if (defaultPort) {
            selectSearchResult({ name: defaultPort.name, type: 'port' });
            initialFetchTriggered = true;
        }

        // 포인트 배너 닫기 버튼
        document.getElementById('portBannerClose').addEventListener('click', () => {
            document.getElementById('portBanner').style.display = 'none';
            document.getElementById('searchPortInfo').style.display = 'none';
        });

        // 탭 전환
        document.querySelectorAll('.tab-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
                document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
                btn.classList.add('active');
                document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
                // 방류 탭 진입 시
                if (btn.dataset.tab === 'discharge') {
                    _clearDischargeNewBadge(); // 탭 뱃지 제거
                    // 현재 newNos를 "확인함"으로 저장 + 목록 N 뱃지 제거
                    if (_dischargeData && _dischargeData.newNos) {
                        _markNosSeen(_dischargeData.newNos);
                    }
                    document.querySelectorAll('.discharge-row.is-new-post').forEach(el => el.classList.remove('is-new-post'));
                    if (!_dischargeLoaded) loadDischargeNotices();
                }
            });
        });

        // ==================== 방류 계획 알림 ====================
        // 낚시포인트 → 관련 댐/호수 키워드 매핑 (제목에서 매칭)
        const PORT_DAM_KEYWORDS = {
            '오천항': ['보령'], '대천항': ['보령'], '무창포': ['보령'],
            '홍원항': ['보령'], '대야도': ['보령'], '영목항': ['보령'],
            '마검포항': ['보령'], '백사장항': ['보령'], '신진도항': ['보령'],
            '남당항': ['보령', '홍성'], '구매항': ['보령', '홍성'],
            '삼길포항': ['삽교', '석문', '간월'], '간월도': ['삽교', '석문', '간월'],
            '안흥외항': ['서산', '삽교'], '궁리포구': ['서산'],
            '전곡항': ['아산', '평택', '남양'],
            '격포항': ['부안', '동진'], '부안변산': ['부안', '동진'],
            '비응항': ['금강', '군산'], '선유도': ['금강', '군산'],
            '녹동항': ['고흥', '나로'], '마량항': ['강진', '장흥', '탐진'],
        };

        function isDischargeRelevant(title, portName) {
            const keywords = PORT_DAM_KEYWORDS[portName];
            if (!keywords) return false;
            return keywords.some(kw => title.includes(kw));
        }

        // 방류 데이터 fetch (캐시 → 프리페치 Promise → 네트워크)
        const DISCHARGE_CACHE_KEY = 'discharge-notice-v3';
        const DISCHARGE_CACHE_TTL = 30 * 60 * 1000; // 30분

        function _fetchDischargeData() {
            return fetch(`${API_BASE}/api/discharge-notice`)
                .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); });
        }

        // 새 글 알림: 탭 버튼에 뱃지 표시
        const DISCHARGE_SEEN_KEY = 'discharge-seen-nos';
        function _getSeenNos() {
            try { return new Set(JSON.parse(sessionStorage.getItem(DISCHARGE_SEEN_KEY) || '[]')); } catch { return new Set(); }
        }
        function _markNosSeen(nos) {
            if (!nos || !nos.length) return;
            const seen = _getSeenNos();
            nos.forEach(n => seen.add(n));
            sessionStorage.setItem(DISCHARGE_SEEN_KEY, JSON.stringify([...seen]));
        }
        function _getUnseenNos(newNos) {
            if (!newNos || !newNos.length) return [];
            const seen = _getSeenNos();
            return newNos.filter(n => !seen.has(n));
        }
        function _showDischargeNewBadge(count) {
            if (count <= 0) return;
            const btn = document.querySelector('.tab-btn[data-tab="discharge"]');
            if (!btn) return;
            btn.classList.add('has-new');
            const badge = btn.querySelector('.new-badge');
            if (badge) badge.textContent = count;
        }
        function _clearDischargeNewBadge() {
            const btn = document.querySelector('.tab-btn[data-tab="discharge"]');
            if (!btn) return;
            btn.classList.remove('has-new');
        }

        // 페이지 로드 시 백그라운드 프리페치 (await 없이 fire-and-forget)
        if (!_getClientCache(DISCHARGE_CACHE_KEY)) {
            _dischargePrefetch = _fetchDischargeData();
            // 프리페치 완료 시 새 글 감지 → 탭 애니메이션 (확인한 글 제외)
            _dischargePrefetch.then(data => {
                if (data && data.newCount > 0) {
                    const unseen = _getUnseenNos(data.newNos);
                    if (unseen.length > 0) _showDischargeNewBadge(unseen.length);
                }
            }).catch(() => {});
        }

        async function loadDischargeNotices(forceRefresh) {
            const container = document.getElementById('dischargeNotice');
            const updatedEl = document.getElementById('dischargeUpdatedAt');
            container.innerHTML = '<div class="center-muted"><div class="spinner" style="display:inline-block;width:24px;height:24px;border:2px solid var(--border);border-top-color:var(--primary);border-radius:50%;animation:spin 0.8s linear infinite;"></div><div style="margin-top:8px;">방류 알림 조회 중...</div></div>';

            try {
                let data;
                // 1) sessionStorage 캐시
                if (!forceRefresh) {
                    const cached = _getClientCache(DISCHARGE_CACHE_KEY);
                    if (cached) { data = cached; }
                }
                // 2) 프리페치 Promise 활용
                if (!data && _dischargePrefetch) {
                    data = await _dischargePrefetch;
                    _dischargePrefetch = null;
                }
                // 3) 네트워크 fetch
                if (!data) {
                    data = await _fetchDischargeData();
                }
                // sessionStorage에 저장
                _setClientCache(DISCHARGE_CACHE_KEY, data, DISCHARGE_CACHE_TTL);
                const notices = data.notices || [];

                _dischargeLoaded = true;
                _dischargeData = data;

                // 아직 확인하지 않은 새 글 번호 (N 뱃지용)
                const unseenNos = _getUnseenNos(data.newNos);

                if (notices.length === 0) {
                    container.innerHTML = '<div class="center-muted">현재 방류 계획 알림이 없습니다.</div>';
                    if (updatedEl) updatedEl.textContent = '';
                    return;
                }

                const portName = _selectedPort ? _selectedPort.name : null;
                const newNoSet = new Set(unseenNos);

                let html = '<table class="discharge-table"><thead><tr>';
                html += '<th>제목</th><th>등록일</th>';
                html += '</tr></thead><tbody>';

                for (let i = 0; i < notices.length; i++) {
                    const n = notices[i];
                    const isMatch = portName && isDischargeRelevant(n.title, portName);
                    const isNew = newNoSet.has(n.no);
                    const rowClass = (isMatch ? ' discharge-highlight' : '') + (isNew ? ' is-new-post' : '');
                    const hasContent = n.content && n.content.trim();
                    html += `<tr class="discharge-row${rowClass}" data-idx="${i}">`;
                    html += `<td><span class="discharge-title" data-idx="${i}"><span class="arrow">▶</span>${escapeHTML(n.title)}</span></td>`;
                    html += `<td>${escapeHTML(n.date)}</td>`;
                    html += '</tr>';
                    if (hasContent) {
                        html += `<tr class="discharge-content-row" id="discharge-content-${i}">`;
                        html += `<td colspan="2" class="discharge-content">${escapeHTML(n.content).replace(/\n\n+/g, '<br><br>').replace(/\n/g, ' ')}</td>`;
                        html += '</tr>';
                    }
                }

                html += '</tbody></table>';
                container.innerHTML = html;

                // 목록을 봤으므로 새 글을 "확인함"으로 저장 + 탭 뱃지 제거
                if (unseenNos.length > 0) {
                    _markNosSeen(unseenNos);
                    _clearDischargeNewBadge();
                }

                // 아코디언 클릭 이벤트
                container.querySelectorAll('.discharge-title').forEach(el => {
                    el.addEventListener('click', () => {
                        const idx = el.dataset.idx;
                        const contentRow = document.getElementById(`discharge-content-${idx}`);
                        if (!contentRow) return;
                        const isOpen = contentRow.classList.toggle('open');
                        el.classList.toggle('open', isOpen);
                    });
                });

                if (updatedEl && data.fetchedAt) {
                    const d = new Date(data.fetchedAt);
                    updatedEl.textContent = `${d.getMonth()+1}/${d.getDate()} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')} 갱신`;
                }
            } catch (err) {
                console.error('방류 알림 로드 실패:', err);
                container.innerHTML = `<div class="error-msg">방류 알림을 불러올 수 없습니다.<br><span class="err-detail">${err.message}</span></div>`;
            }
        }

        // 새로고침 버튼 (강제 갱신)
        document.getElementById('dischargeReloadBtn')?.addEventListener('click', () => {
            _dischargeLoaded = false;
            loadDischargeNotices(true);
        });

        // 30분 자동 갱신 (캐시 TTL과 동일)
        setInterval(() => {
            // 방류 탭이 활성화되어 있으면 자동 갱신
            const dischargeTab = document.getElementById('tab-discharge');
            if (dischargeTab && dischargeTab.classList.contains('active')) {
                loadDischargeNotices(true);
            } else {
                // 비활성 상태면 다음 진입 시 새로 로드하도록 플래그 리셋
                _dischargeLoaded = false;
            }
        }, 30 * 60 * 1000);

        // 검색 이벤트
        const searchInput = document.getElementById('searchInput');
        const searchResults = document.getElementById('searchResults');
        let debounceTimer = null;

        searchInput.addEventListener('input', () => {
            clearTimeout(debounceTimer);
            searchInput.dataset.prefilled = '0';
            debounceTimer = setTimeout(() => {
                const q = searchInput.value.trim();
                if (q.length === 0) { searchResults.classList.remove('show'); return; }
                const results = doSearch(q);
                renderSearchResults(results, q);
            }, 150);
        });

        searchInput.addEventListener('focus', () => {
            const q = searchInput.value.trim();
            if (q.length > 0) {
                const results = doSearch(q);
                renderSearchResults(results, q);
            }
        });

        document.addEventListener('click', (e) => {
            if (!e.target.closest('.search-bar')) {
                searchResults.classList.remove('show');
            }
            // 바다낚시지수 팝업
            const fishBtn = e.target.closest('.fishing-index-btn');
            if (fishBtn) {
                e.stopPropagation();
                const existing = document.querySelector('.fishing-popup');
                if (existing) { existing.remove(); return; }
                const popup = document.createElement('div');
                popup.className = 'fishing-popup';
                popup.innerHTML = escapeHTML(fishBtn.dataset.popup).replace(/\n/g, '<br>');
                fishBtn.parentElement.appendChild(popup);
                return;
            }
            const existingPopup = document.querySelector('.fishing-popup');
            if (existingPopup && !e.target.closest('.fishing-popup')) existingPopup.remove();
        });

        searchInput.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') searchResults.classList.remove('show');
            if (e.key === 'Enter') {
                e.preventDefault();
                clearTimeout(debounceTimer);
                const q = searchInput.value.trim();
                if (q.length === 0) return;
                const results = doSearch(q);
                if (results.length > 0) {
                    selectSearchResult(results[0]);
                    searchInput.blur();
                }
                searchResults.classList.remove('show');
            }
        });

        // 접속 시 오늘 날짜 데이터 자동 조회 보장
        if (!initialFetchTriggered) {
            fetchAll();
        }

        // ==================== 인라인 핸들러 → 이벤트 바인딩 ====================
        // 검색바 클릭
        document.getElementById('searchBar').addEventListener('click', focusAndClearSearchInput);

        // 월 이동 버튼
        document.querySelectorAll('[data-month-shift]').forEach(btn => {
            btn.addEventListener('click', () => shiftMonth(parseInt(btn.dataset.monthShift, 10)));
        });

        // 날짜 표시 클릭 → 날짜 선택기 열기
        document.getElementById('dateDisplay').addEventListener('click', () => {
            const inp = document.getElementById('dateInput');
            if (inp.showPicker) inp.showPicker();
            else inp.focus();
        });

        // 일 이동 버튼
        document.getElementById('btnPrev').addEventListener('click', () => shiftDay(-1));
        document.getElementById('btnNext').addEventListener('click', () => shiftDay(1));

        // 오늘 버튼
        document.getElementById('btnToday').addEventListener('click', () => {
            document.getElementById('dateInput').value = new Date(
                new Date().getTime() + 9 * 60 * 60 * 1000
            ).toISOString().split('T')[0];
            updateDateDisplay();
            fetchAll();
        });

        // 조위 그래프 새로고침
        document.getElementById('tideChartReloadBtn').addEventListener('click', refreshTideChart);

        // 물때 새로고침
        document.getElementById('mulddaeReloadBtn').addEventListener('click', async () => {
            const btn = document.getElementById('mulddaeReloadBtn');
            if (btn.disabled) return;
            btn.disabled = true;
            btn.classList.add('is-spinning');
            try {
                await Promise.all([fetchTideHighLow(), fetchCurrentData()]);
                await fetchTidePrediction();
                renderCombinedChart();
            } catch(e) { console.error('물때 새로고침 오류:', e); }
            btn.classList.remove('is-spinning');
            btn.disabled = false;
        });

        // 어종 버튼
        document.querySelectorAll('.species-btn').forEach(btn => {
            btn.addEventListener('click', () => toggleSpecies(btn.dataset.species));
        });

        // 유속 단위 전환 버튼
        document.querySelectorAll('.current-unit-toggle-btn').forEach(btn => {
            btn.addEventListener('click', toggleCurrentSpeedUnit);
        });
    });

    function showToast(msg, isError = false) {
        let toast = document.getElementById('toastMsg');
        if (!toast) {
            toast = document.createElement('div');
            toast.id = 'toastMsg';
            toast.style.cssText = 'position:fixed;top:20px;left:50%;transform:translateX(-50%);padding:12px 24px;border-radius:8px;color:#fff;font-size:14px;z-index:9999;opacity:0;transition:opacity 0.3s;pointer-events:none;';
            document.body.appendChild(toast);
        }
        toast.textContent = msg;
        toast.style.background = isError ? '#e74c3c' : '#00e0ff';
        toast.style.color = isError ? '#fff' : '#0a0f1a';
        toast.style.opacity = '1';
        setTimeout(() => { toast.style.opacity = '0'; }, 2500);
    }

    function updateDateDisplay() {
        const v = document.getElementById('dateInput').value;
        if (!v) return;
        const [y, m, d] = v.split('-');
        document.getElementById('dateDisplay').textContent = y + '년 ' + m + '월 ' + d + '일';
    }
    function shiftMonth(dir) {
        const inp = document.getElementById('dateInput');
        const d = new Date(inp.value);
        d.setMonth(d.getMonth() + dir);
        inp.value = d.toISOString().split('T')[0];
        updateDateDisplay();
        fetchAll();
    }
    function shiftDay(dir) {
        const inp = document.getElementById('dateInput');
        const d = new Date(inp.value);
        d.setDate(d.getDate() + dir);
        inp.value = d.toISOString().split('T')[0];
        updateDateDisplay();
        fetchAll();
    }
    function getDateStr() {
        const v = document.getElementById('dateInput').value;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return getKSTDateStr().replace(/-/g, '');
        return v.replace(/-/g, '');
    }
    function getStation() { return document.getElementById('stationSelect').value; }
    function getCurrentStation() { return document.getElementById('currentSelect').value; }

    // ==================== 음력 변환 & 물때 계산 ====================
    // korean-lunar-calendar 라이브러리 사용 (KASI 기반 정확한 음력 변환)
    function solarToLunar(year, month, day) {
        try {
            const cal = new KoreanLunarCalendar();
            cal.setSolarDate(year, month, day);
            const lunar = cal.getLunarCalendar();
            return {
                lunarMonth: lunar.month,
                lunarDay: lunar.day,
                isLeapMonth: lunar.intercalation
            };
        } catch (e) {
            console.error('음력 변환 오류:', e);
            return { lunarMonth: 1, lunarDay: 1, isLeapMonth: false };
        }
    }

    // moon 폴더 월령 아이콘 매핑 (0.svg~29.svg, 음력일-1 인덱스)
    function getMoonPhaseIconSrc(lunarDay) {
        const safeDay = (typeof lunarDay === 'number' && lunarDay >= 1 && lunarDay <= 30) ? lunarDay : 1;
        const idx = safeDay - 1; // 음력 1일=0.svg, 15일=14.svg, 30일=29.svg
        return `moon/${idx}.svg`;
    }

    function getMulddae(lunarDay) {
        // 바다타임 기준 7물때식 (서해 표준)
        // pct는 기본 추정값 (실제 조차 데이터로 덮어쓸 수 있음)
        const mulddaeMap = {
            1:  { name: '사리', num: '7물', color: '#ff6b6b', emoji: '🔴', pct: 98 },
            2:  { name: '사리', num: '8물', color: '#ff6b6b', emoji: '🔴', pct: 95 },
            3:  { name: '사리', num: '9물', color: '#ff6b6b', emoji: '🔴', pct: 90 },
            4:  { name: '사리', num: '10물', color: '#ffa726', emoji: '🟠', pct: 83 },
            5:  { name: '사리', num: '11물', color: '#ffa726', emoji: '🟠', pct: 73 },
            6:  { name: '사리', num: '12물', color: '#ffa726', emoji: '🟠', pct: 60 },
            7:  { name: '사리', num: '13물', color: '#ffa726', emoji: '🟠', pct: 45 },
            8:  { name: '조금', num: '조금', color: '#4ecdc4', emoji: '🟢', pct: 30 },
            9:  { name: '무시', num: '무시', color: '#7a8ba3', emoji: '⚪', pct: 25 },
            10: { name: '들물', num: '1물', color: '#4fc3f7', emoji: '🔵', pct: 33 },
            11: { name: '들물', num: '2물', color: '#4fc3f7', emoji: '🔵', pct: 43 },
            12: { name: '들물', num: '3물', color: '#4fc3f7', emoji: '🔵', pct: 55 },
            13: { name: '들물', num: '4물', color: '#4fc3f7', emoji: '🔵', pct: 68 },
            14: { name: '들물', num: '5물', color: '#4fc3f7', emoji: '🔵', pct: 80 },
            15: { name: '사리', num: '6물', color: '#ff6b6b', emoji: '🔴', pct: 90 },
            16: { name: '사리', num: '7물', color: '#ff6b6b', emoji: '🔴', pct: 98 },
            17: { name: '사리', num: '8물', color: '#ff6b6b', emoji: '🔴', pct: 95 },
            18: { name: '사리', num: '9물', color: '#ff6b6b', emoji: '🔴', pct: 90 },
            19: { name: '사리', num: '10물', color: '#ffa726', emoji: '🟠', pct: 83 },
            20: { name: '사리', num: '11물', color: '#ffa726', emoji: '🟠', pct: 73 },
            21: { name: '사리', num: '12물', color: '#ffa726', emoji: '🟠', pct: 60 },
            22: { name: '사리', num: '13물', color: '#ffa726', emoji: '🟠', pct: 45 },
            23: { name: '조금', num: '조금', color: '#4ecdc4', emoji: '🟢', pct: 30 },
            24: { name: '무시', num: '무시', color: '#7a8ba3', emoji: '⚪', pct: 25 },
            25: { name: '들물', num: '1물', color: '#4fc3f7', emoji: '🔵', pct: 33 },
            26: { name: '들물', num: '2물', color: '#4fc3f7', emoji: '🔵', pct: 43 },
            27: { name: '들물', num: '3물', color: '#4fc3f7', emoji: '🔵', pct: 55 },
            28: { name: '들물', num: '4물', color: '#4fc3f7', emoji: '🔵', pct: 68 },
            29: { name: '들물', num: '5물', color: '#4fc3f7', emoji: '🔵', pct: 80 },
            30: { name: '사리', num: '6물', color: '#ff6b6b', emoji: '🔴', pct: 90 },
        };
        const safeDay = (lunarDay >= 1 && lunarDay <= 30) ? lunarDay : 1;
        return mulddaeMap[safeDay] || mulddaeMap[1];
    }

    function getMulddaeBarColor(pct) {
        if (pct >= 76) return '#ff6b6b';
        if (pct >= 51) return '#ffa726';
        if (pct >= 26) return '#4fc3f7';
        return '#81c784';
    }

    // 관측소별 사리 기준 최대 조차 (cm) - 실측 기반 참고값
    const MAX_TIDAL_RANGE = {
        // 인천/경기
        'DT_0001': 900, 'DT_0052': 880, 'DT_0044': 870, 'DT_0032': 850,
        'DT_0043': 850, 'DT_0093': 860, 'DT_0065': 800, 'DT_0066': 780,
        'DT_0002': 850, 'DT_0008': 870,
        // 충남/전북
        'DT_0050': 700, 'DT_0067': 650, 'DT_0017': 750, 'DT_0025': 750,
        'DT_0051': 650, 'DT_0024': 650, 'DT_0018': 600, 'DT_0068': 450, 'DT_0037': 400,
        // 전남서부
        'DT_0007': 400, 'DT_0035': 300, 'DT_0094': 350,
        // 전남동부
        'DT_0028': 350, 'DT_0027': 350, 'DT_0026': 350, 'DT_0092': 320,
        'DT_0016': 300, 'DT_0049': 300, 'DT_0031': 250,
        // 남해/경남
        'DT_0061': 250, 'DT_0014': 200, 'DT_0003': 200, 'DT_0029': 200,
        'DT_0063': 180, 'DT_0062': 180, 'DT_0056': 150,
        'DT_0013': 150, 'DT_0033': 180, 'DT_0015': 150, 'DT_0048': 130, 'DT_0030': 120,
        // 부산/울산
        'DT_0005': 120, 'DT_0020': 50,
        // 동해
        'DT_0091': 30, 'DT_0039': 30, 'DT_0011': 30, 'DT_0057': 30,
        'DT_0006': 35, 'DT_0012': 30,
        'DT_0019': 30, 'DT_0034': 30, 'DT_0036': 25,
        // 제주
        'DT_0004': 250, 'DT_0022': 200, 'DT_0010': 200, 'DT_0023': 200, 'DT_0021': 350,
        // 특수 (교본초/이어도/가거초/소청초)
        'DT_0042': 300, 'IE_0060': 200, 'IE_0061': 350, 'IE_0062': 800,
    };

    // 관측소별 소조기(조금) 최소 조차 (cm) — 실측 기반 참고값
    const MIN_TIDAL_RANGE = {
        // 인천/경기
        'DT_0001': 200, 'DT_0052': 190, 'DT_0044': 190, 'DT_0032': 180,
        'DT_0043': 180, 'DT_0093': 185, 'DT_0065': 170, 'DT_0066': 165,
        'DT_0002': 180, 'DT_0008': 190,
        // 충남/전북
        'DT_0050': 150, 'DT_0067': 140, 'DT_0017': 150, 'DT_0025': 150,
        'DT_0051': 140, 'DT_0024': 140, 'DT_0018': 130, 'DT_0068': 100, 'DT_0037': 90,
        // 전남서부
        'DT_0007': 90, 'DT_0035': 70, 'DT_0094': 80,
        // 전남동부
        'DT_0028': 80, 'DT_0027': 80, 'DT_0026': 80, 'DT_0092': 70,
        'DT_0016': 70, 'DT_0049': 70, 'DT_0031': 55,
        // 남해/경남
        'DT_0061': 55, 'DT_0014': 45, 'DT_0003': 45, 'DT_0029': 45,
        'DT_0063': 40, 'DT_0062': 40, 'DT_0056': 35,
        'DT_0013': 35, 'DT_0033': 40, 'DT_0015': 35, 'DT_0048': 30, 'DT_0030': 25,
        // 부산/울산
        'DT_0005': 25, 'DT_0020': 10,
        // 동해
        'DT_0091': 5, 'DT_0039': 5, 'DT_0011': 5, 'DT_0057': 5,
        'DT_0006': 7, 'DT_0012': 5,
        'DT_0019': 5, 'DT_0034': 5, 'DT_0036': 5,
        // 제주
        'DT_0004': 55, 'DT_0022': 45, 'DT_0010': 45, 'DT_0023': 45, 'DT_0021': 80,
        // 특수 (교본초/이어도/가거초/소청초)
        'DT_0042': 70, 'IE_0060': 45, 'IE_0061': 80, 'IE_0062': 170,
    };

    // ==================== 물흐름 퍼센트 유틸리티 ====================
    function clamp(v, lo, hi) {
        return Math.max(lo, Math.min(hi, v));
    }


    // ==================== 동적 조차 범위 (±15일 윈도우) ====================
    const TIDAL_DIFFS_CACHE_PREFIX = 'tidalDiffs:';
    const TIDAL_DIFFS_CACHE_TTL = 24 * 60 * 60 * 1000; // 24시간

    function getCachedTidalDiffs(stationCode, dateStr) {
        try {
            const monthKey = dateStr.substring(0, 6);
            const raw = localStorage.getItem(`${TIDAL_DIFFS_CACHE_PREFIX}${stationCode}:${monthKey}`);
            if (!raw) return null;
            const cached = JSON.parse(raw);
            if (Date.now() - cached.ts > TIDAL_DIFFS_CACHE_TTL) return null;
            return cached.data;
        } catch { return null; }
    }

    function setCachedTidalDiffs(stationCode, dateStr, data) {
        try {
            const monthKey = dateStr.substring(0, 6);
            localStorage.setItem(
                `${TIDAL_DIFFS_CACHE_PREFIX}${stationCode}:${monthKey}`,
                JSON.stringify({ ts: Date.now(), data })
            );
            // 오래된 캐시 정리 (최대 10개 유지)
            const keys = [];
            for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                if (k && k.startsWith(TIDAL_DIFFS_CACHE_PREFIX)) keys.push(k);
            }
            if (keys.length > 10) {
                const entries = keys.map(k => {
                    try { return { k, ts: JSON.parse(localStorage.getItem(k)).ts }; }
                    catch { return { k, ts: 0 }; }
                }).sort((a, b) => a.ts - b.ts);
                for (let i = 0; i < entries.length - 10; i++) localStorage.removeItem(entries[i].k);
            }
        } catch { /* localStorage 사용 불가 시 무시 */ }
    }

    async function fetchLunarMonthDiffs(stationCode, dateStr) {
        const y = parseInt(dateStr.substring(0, 4));
        const m = parseInt(dateStr.substring(4, 6)) - 1;
        const d = parseInt(dateStr.substring(6, 8));
        const center = new Date(y, m, d);
        const start = new Date(center.getTime() - 15 * 86400000);

        const startStr = [
            start.getFullYear(),
            String(start.getMonth() + 1).padStart(2, '0'),
            String(start.getDate()).padStart(2, '0')
        ].join('');

        const items = await apiCall('tideFcstHghLw/GetTideFcstHghLwApiService', {
            obsCode: stationCode,
            reqDate: startStr,
            numOfRows: '140',
            pageNo: '1'
        });

        if (!items || items.length === 0) return null;

        // 날짜별 그룹핑 → 일별 고저차 계산
        const byDate = {};
        for (const item of items) {
            if (!item.predcDt) continue;
            const dk = item.predcDt.substring(0, 10).replace(/-/g, '');
            if (!byDate[dk]) byDate[dk] = [];
            byDate[dk].push(item);
        }

        const diffs = {};
        for (const [dk, dayItems] of Object.entries(byDate)) {
            const filtered = dayItems.filter(i => {
                const t = (i.predcDt || '').substring(11, 16);
                return t >= '05:00' && t <= '18:00';
            });
            const highs = filtered.filter(i => parseInt(i.extrSe) % 2 === 1 && i.predcTdlvVl != null);
            const lows = filtered.filter(i => parseInt(i.extrSe) % 2 === 0 && i.predcTdlvVl != null);
            if (highs.length > 0 && lows.length > 0) {
                const maxH = safeMax(highs.map(h => parseFloat(h.predcTdlvVl)));
                const minL = safeMin(lows.map(l => parseFloat(l.predcTdlvVl)));
                if (maxH > minL) diffs[dk] = Math.round((maxH - minL) * 10) / 10;
            }
        }

        const sortedEntries = Object.entries(diffs)
            .map(([date, diff]) => ({ date, diff }))
            .sort((a, b) => a.date.localeCompare(b.date));
        if (sortedEntries.length < 3) return null;

        // 전체 윈도우 MIN/MAX
        const vals = sortedEntries.map(e => e.diff);
        const windowRange = { min: safeMin(vals), max: safeMax(vals) };

        return { diffs, windowRange, sortedEntries };
    }

    // 조차 기반 유속 퍼센트 계산 — 동적 윈도우 우선, 고정 테이블 fallback (2순위: crsp 없는 관측소용)
    function calcRangeFlowPct(diff, stationCode, rangeData) {
        if (diff == null || diff <= 0) return null;
        let maxRange, minRange;
        // 1순위: ±15일 윈도우 동적 범위
        if (rangeData && rangeData.windowRange && rangeData.windowRange.max > rangeData.windowRange.min) {
            maxRange = rangeData.windowRange.max;
            minRange = rangeData.windowRange.min;
        // 2순위: 고정 테이블
        } else {
            maxRange = MAX_TIDAL_RANGE[stationCode] || 300;
            minRange = MIN_TIDAL_RANGE[stationCode] || Math.round(maxRange * 0.2);
        }
        if (maxRange <= minRange) return null;
        const pct = ((diff - minRange) / (maxRange - minRange)) * 100;
        return Math.round(clamp(pct, 0, 100));
    }

    // ==================== 유속(crsp) 직접 정규화 ====================

    const CRSP_WINDOW_CACHE_PREFIX = 'crspWindow:';
    const CRSP_WINDOW_CACHE_TTL = 24 * 60 * 60 * 1000; // 24시간

    function getCachedCrspWindow(currentStationCode, dateStr) {
        try {
            const monthKey = dateStr.substring(0, 6);
            const raw = localStorage.getItem(`${CRSP_WINDOW_CACHE_PREFIX}${currentStationCode}:${monthKey}`);
            if (!raw) return null;
            const cached = JSON.parse(raw);
            if (Date.now() - cached.ts > CRSP_WINDOW_CACHE_TTL) return null;
            return cached.data;
        } catch { return null; }
    }

    function setCachedCrspWindow(currentStationCode, dateStr, data) {
        try {
            const monthKey = dateStr.substring(0, 6);
            localStorage.setItem(
                `${CRSP_WINDOW_CACHE_PREFIX}${currentStationCode}:${monthKey}`,
                JSON.stringify({ ts: Date.now(), data })
            );
            // 오래된 캐시 정리 (최대 10개 유지)
            const keys = [];
            for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                if (k && k.startsWith(CRSP_WINDOW_CACHE_PREFIX)) keys.push(k);
            }
            if (keys.length > 10) {
                const entries = keys.map(k => {
                    try { return { k, ts: JSON.parse(localStorage.getItem(k)).ts }; }
                    catch { return { k, ts: 0 }; }
                }).sort((a, b) => a.ts - b.ts);
                for (let i = 0; i < entries.length - 10; i++) localStorage.removeItem(entries[i].k);
            }
        } catch { /* localStorage 사용 불가 시 무시 */ }
    }

    // 유속(crsp) 직접 정규화: 해당일 max crsp를 ±15일 윈도우 max crsp의 min/max로 정규화
    function calcCrspFlowPct(todayMaxSpeed, windowMaxSpeeds) {
        if (todayMaxSpeed == null || !windowMaxSpeeds || windowMaxSpeeds.length < 3) return null;
        const wMin = safeMin(windowMaxSpeeds);
        const wMax = safeMax(windowMaxSpeeds);
        if (wMax <= wMin) return null;
        const pct = ((todayMaxSpeed - wMin) / (wMax - wMin)) * 100;
        return Math.round(clamp(pct, 0, 100));
    }

    // Worker /api/current-window 엔드포인트에서 ±15일 일별 max crsp 조회
    async function fetchCrspWindow(currentStationCode, dateStr) {
        const cached = getCachedCrspWindow(currentStationCode, dateStr);
        if (cached) return cached;

        const resp = await apiCallRaw('/api/current-window', {
            obsCode: currentStationCode,
            reqDate: dateStr
        });
        if (!resp || !resp.dailyMaxSpeeds || resp.dailyMaxSpeeds.length === 0) return null;

        const result = resp.dailyMaxSpeeds; // [{date, maxCrsp}, ...]
        setCachedCrspWindow(currentStationCode, dateStr, result);
        return result;
    }

    function getMulddaeInfo(dateStr) {
        const y = parseInt(dateStr.substring(0, 4));
        const m = parseInt(dateStr.substring(4, 6));
        const d = parseInt(dateStr.substring(6, 8));
        const lunar = solarToLunar(y, m, d);
        const mulddae = getMulddae(lunar.lunarDay);
        return { ...mulddae, lunarMonth: lunar.lunarMonth, lunarDay: lunar.lunarDay };
    }

    let mulddaeCardState = null;
    _lastMulddaePct = null;
    _fishingIndexInfo = null;

    // #17: rAF debounce — 같은 프레임 내 다중 호출을 1회로 통합
    let _mulddaeRenderPending = false;
    function renderMulddaeCardFromState() {
        if (!mulddaeCardState) return;
        if (_mulddaeRenderPending) return;
        _mulddaeRenderPending = true;
        requestAnimationFrame(() => {
            _mulddaeRenderPending = false;
            _doRenderMulddaeCard();
        });
    }

    function _doRenderMulddaeCard() {
        if (!mulddaeCardState) return;
        const mulddaeCard = document.getElementById('mulddaeCard');
        const mulddaeEl = document.getElementById('mulddaeInfo');
        if (!mulddaeCard || !mulddaeEl) return;

        const { dateStr, stationCode, mulddaeBase, diff, rangePct } = mulddaeCardState;
        const mulddae = { ...mulddaeBase };
        if (Number.isFinite(rangePct)) mulddae.pct = clamp(Math.round(rangePct), 0, 100);
        _lastMulddaePct = mulddae.pct;

        mulddaeCard.style.display = '';
        document.getElementById('mulddaeDate').textContent = `${mulddae.name} | 양력 ${dateStr.substring(0,4)}.${dateStr.substring(4,6)}.${dateStr.substring(6,8)} | 음력 ${mulddae.lunarMonth}월 ${mulddae.lunarDay}일`;

        const desc = mulddae.num === '조금' ? '소조기 — 조차가 가장 작고 물살이 약합니다'
            : mulddae.num === '무시' ? '조금 직후 — 물흐름이 가장 약한 날입니다'
            : mulddae.name === '사리' && mulddae.pct >= 90 ? '대조기 — 조차가 크고 물살이 셉니다'
            : mulddae.name === '사리' ? '사리 전후 — 조차가 점차 줄어듭니다'
            : '들물 — 조금→사리 전환기, 조차가 커지는 중입니다';
        const speciesFit = getSpeciesByMulddae(mulddae.num, mulddae.pct, diff);

        const pctValue = Number.isFinite(mulddae.pct) ? mulddae.pct : null;
        const pctText = pctValue != null ? `${pctValue}%` : '-';
        const fishingInfo = (_fishingIndexInfo && _fishingIndexInfo.reqDate === dateStr)
            ? _fishingIndexInfo
            : null;
        let fishingText = '';

        if (fishingInfo) {
            const gradeText = fishingInfo.grade ? `${escapeHTML(fishingInfo.grade)}` : '';
            const detailLines = [];
            if (fishingInfo.placeName) detailLines.push(`📍 ${escapeHTML(fishingInfo.placeName)}`);
            if (fishingInfo.baseTime) detailLines.push(`🕐 ${escapeHTML(fishingInfo.baseTime)}`);
            if (fishingInfo.airTemp) detailLines.push(`🌡 기온 ${escapeHTML(fishingInfo.airTemp)}℃`);
            if (fishingInfo.waterTemp) detailLines.push(`🌊 수온 ${escapeHTML(fishingInfo.waterTemp)}℃`);
            if (fishingInfo.waveHeight) detailLines.push(`〰 파고 ${escapeHTML(fishingInfo.waveHeight)}m`);
            if (fishingInfo.windSpeed) detailLines.push(`💨 풍속 ${escapeHTML(fishingInfo.windSpeed)}m/s`);
            if (fishingInfo.tideTimeScore) detailLines.push(`🌙 물때점수 ${escapeHTML(fishingInfo.tideTimeScore)}`);
            const popupData = detailLines.join('\n');
            fishingText = `<span class="fishing-index-btn" data-popup="${escapeHTML(popupData)}">🎣 바다낚시지수(선상) ㅡ ${gradeText}</span>`;
        }

        mulddaeEl.innerHTML = `
            <div class="mulddae-row1">
                <div class="mulddae-badge" style="background:${pctValue != null ? getMulddaeBarColor(pctValue) : mulddae.color}22; color:${pctValue != null ? getMulddaeBarColor(pctValue) : mulddae.color};">
                    <img class="mulddae-moon" src="${getMoonPhaseIconSrc(mulddae.lunarDay)}" alt="달">
                    <span class="mulddae-num">${mulddae.num}</span>
                </div>
                <div class="mulddae-pct-wrap">
                    <div class="mulddae-pct-head">
                        <span class="mulddae-pct-label-inline">오늘의 유속 (05:00~18:00 기준)</span>
                        <span class="mulddae-pct-value" style="color:${pctValue != null ? getMulddaeBarColor(pctValue) : mulddae.color};">${pctText}</span>
                    </div>
                    <div class="mulddae-pct-bar"><div class="mulddae-pct-bar-fill" style="width:${pctValue != null ? pctValue : 0}%;background:${pctValue != null ? getMulddaeBarColor(pctValue) : mulddae.color};"></div></div>
                </div>
            </div>
            <div class="mulddae-desc">${desc}</div>
            <div class="fishing-weather-row">
                ${fishingText ? `<div class="fishing-index-wrap">${fishingText}</div>` : '<div></div>'}
                ${(() => {
                    const w = _weatherInfo;
                    if (!w) return '';
                    const t = parseFloat(w.tmp);
                    const tDisplay = isNaN(t) ? '--' : (Number.isInteger(t) ? t : t.toFixed(1));
                    const tc = isNaN(t) ? 'mild' : t <= 0 ? 'freeze' : t <= 10 ? 'cold' : t <= 20 ? 'mild' : t <= 30 ? 'warm' : 'hot';
                    return `<div class="weather-widget wt-${tc}">
                        <img src="moon/weather/${w.iconFile}" alt="날씨" class="weather-widget-icon">
                        <div class="weather-widget-text">
                            <span class="weather-widget-label">오늘의 날씨</span>
                            <span class="weather-widget-temp">${tDisplay}°</span>
                        </div>
                    </div>`;
                })()}
            </div>
            <div class="mulddae-species">
                ${(() => {
                    // 쭈꾸미·문어는 한 줄로 합침
                    const jj = speciesFit.find(s => s.name === '쭈꾸미');
                    const mn = speciesFit.find(s => s.name === '문어');
                    const go = speciesFit.find(s => s.name === '갑오징어');
                    let html = '';
                    // 쭈꾸미 · 문어 합친 카드
                    if (jj && mn) {
                        const mergedBg = `${jj.color}15`;
                        const mergedBorder = `${jj.color}33`;
                        html += `<div class="species-card-wrap">
                        <div class="species-card-row" style="background:${mergedBg};border:1px solid ${mergedBorder};flex-wrap:wrap;">
                            <span>🐙</span>
                            <span class="species-name">쭈꾸미</span>
                            <span style="color:var(--muted);margin:0 2px;">·</span>
                            <span class="species-name">문어</span>
                        </div>`;
                        html += `<div class="species-detail-line">🌊 <span style="color:${jj.color};font-weight:600;">${jj.grade}</span> <span>${jj.desc}</span></div>`;
                        if (jj.diffInfo) html += `<div class="species-detail-line">📏 <span style="color:${jj.diffColor};font-weight:600;">${jj.diffInfo.grade}</span> <span>${jj.diffInfo.desc}</span></div>`;
                        html += `</div>`;
                    }
                    // 갑오징어 별도 카드
                    if (go) {
                        const diffLine = go.diffInfo ? `<div class="species-detail-line">📏 <span style="color:${go.diffColor};font-weight:600;">${go.diffInfo.grade}</span> <span>${go.diffInfo.desc}</span></div>` : '';
                        html += `<div class="species-card-wrap">
                        <div class="species-card-row" style="background:${go.color}15;border:1px solid ${go.color}33;">
                            <span>${go.emoji}</span>
                            <span class="species-name">${go.name}</span>
                        </div>
                        <div class="species-detail-line">🌊 <span style="color:${go.color};font-weight:600;">${go.grade}</span> <span>${go.desc}</span></div>${diffLine}</div>`;
                    }
                    return html;
                })()}
            </div>`;
    }

    // ==================== 일출/일몰 천문계산 (SunCalc 알고리즘) ====================
    // 관측소 코드 → 위도/경도 매핑
    const STATION_COORDS = {
        // 인천/경기
        'DT_0001': [37.45, 126.59], 'DT_0052': [37.35, 126.65], 'DT_0044': [37.53, 126.57],
        'DT_0032': [37.73, 126.53], 'DT_0043': [37.25, 126.47], 'DT_0093': [37.38, 126.42],
        'DT_0065': [37.23, 126.15], 'DT_0066': [37.18, 126.20], 'DT_0002': [36.97, 126.82],
        'DT_0008': [37.18, 126.65],
        // 충남/전북
        'DT_0050': [36.90, 126.17], 'DT_0067': [36.67, 126.13], 'DT_0017': [36.97, 126.37],
        'DT_0025': [36.40, 126.55], 'DT_0051': [36.07, 126.52], 'DT_0024': [36.00, 126.68],
        'DT_0018': [35.97, 126.72], 'DT_0068': [35.62, 126.30], 'DT_0037': [36.12, 125.85],
        // 전남서부
        'DT_0007': [34.78, 126.38], 'DT_0035': [34.68, 125.43], 'DT_0094': [34.42, 125.95],
        // 전남동부
        'DT_0028': [34.48, 127.73], 'DT_0027': [34.73, 127.75], 'DT_0026': [34.48, 127.08],
        'DT_0092': [34.57, 127.30], 'DT_0016': [34.75, 127.77], 'DT_0049': [34.30, 127.53],
        'DT_0031': [34.30, 126.52],
        // 남해/경남
        'DT_0061': [34.83, 128.42], 'DT_0014': [34.85, 128.43], 'DT_0003': [35.08, 128.03],
        'DT_0029': [34.92, 128.07], 'DT_0063': [34.73, 128.33], 'DT_0062': [34.80, 128.57],
        'DT_0056': [34.70, 128.73], 'DT_0013': [34.82, 128.60], 'DT_0033': [34.85, 128.43],
        'DT_0015': [34.73, 128.02], 'DT_0048': [34.75, 128.90], 'DT_0030': [34.92, 127.90],
        // 부산/울산
        'DT_0005': [35.08, 129.03], 'DT_0020': [35.50, 129.38],
        // 동해
        'DT_0091': [36.02, 129.57], 'DT_0039': [37.48, 129.17], 'DT_0011': [36.68, 129.48],
        'DT_0057': [37.48, 129.13], 'DT_0006': [38.20, 128.60], 'DT_0012': [37.87, 128.83],
        'DT_0019': [36.40, 129.38], 'DT_0034': [37.08, 129.40], 'DT_0036': [36.73, 129.47],
        // 제주
        'DT_0004': [33.52, 126.53], 'DT_0022': [33.47, 126.93], 'DT_0010': [33.25, 126.57],
        'DT_0023': [33.47, 126.93], 'DT_0021': [33.52, 126.25],
    };

    function getSunTimes(date, lat, lon) {
        // 천문계산 기반 일출/일몰 (NOAA 알고리즘 간소화)
        const rad = Math.PI / 180;
        const dayOfYear = Math.floor((date - new Date(date.getFullYear(), 0, 0)) / 86400000);
        const lngHour = lon / 15;

        // 일출/일몰 계산 함수
        function calcSunTime(rising) {
            const t = rising ? dayOfYear + (6 - lngHour) / 24 : dayOfYear + (18 - lngHour) / 24;

            // 태양 평균근점이각
            const M = (0.9856 * t) - 3.289;

            // 태양 황경
            let L = M + (1.916 * Math.sin(M * rad)) + (0.020 * Math.sin(2 * M * rad)) + 282.634;
            L = ((L % 360) + 360) % 360;

            // 태양 적경
            let RA = Math.atan(0.91764 * Math.tan(L * rad)) / rad;
            RA = ((RA % 360) + 360) % 360;

            const Lquad = Math.floor(L / 90) * 90;
            const RAquad = Math.floor(RA / 90) * 90;
            RA = RA + (Lquad - RAquad);
            RA = RA / 15;

            // 태양 적위
            const sinDec = 0.39782 * Math.sin(L * rad);
            const cosDec = Math.cos(Math.asin(sinDec));

            // 시간각 (일출/일몰: -0.833도 = 대기굴절 보정)
            const zenith = 90.833;
            const cosH = (Math.cos(zenith * rad) - (sinDec * Math.sin(lat * rad))) / (cosDec * Math.cos(lat * rad));

            if (cosH > 1 || cosH < -1) return null; // 극지방 처리

            let H = rising
                ? (360 - Math.acos(cosH) / rad) / 15
                : Math.acos(cosH) / rad / 15;

            const T = H + RA - (0.06571 * t) - 6.622;
            let UT = ((T - lngHour) % 24 + 24) % 24;

            // KST (UTC+9)
            let KST = UT + 9;
            if (KST >= 24) KST -= 24;

            let hours = Math.floor(KST);
            let minutes = Math.round((KST - hours) * 60);
            if (minutes === 60) { minutes = 0; hours = (hours + 1) % 24; }
            return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
        }

        return {
            sunrise: calcSunTime(true),
            sunset: calcSunTime(false)
        };
    }

    function getSunTimesForStation(dateStr, stationCode) {
        // FISHING_PORTS에서 현재 관측소에 매칭되는 포트 좌표 우선, 없으면 STATION_COORDS 사용
        const port = FISHING_PORTS.find(p => p.station === stationCode);
        let lat, lon;
        if (port) {
            lat = port.lat;
            lon = port.lon;
        } else if (STATION_COORDS[stationCode]) {
            [lat, lon] = STATION_COORDS[stationCode];
        } else {
            // fallback: 서울 기준
            lat = 37.5; lon = 126.97;
        }

        const y = parseInt(dateStr.substring(0, 4));
        const m = parseInt(dateStr.substring(4, 6)) - 1;
        const d = parseInt(dateStr.substring(6, 8));
        return getSunTimes(new Date(y, m, d), lat, lon);
    }

    // ==================== GENERIC API CALL (Worker 프록시 경유) ====================
    const PROXY_ENDPOINT_MAP = {
        'tideFcstHghLw/GetTideFcstHghLwApiService': '/api/tide-hilo',
        'surveyTideLevel/GetSurveyTideLevelApiService': '/api/tide-level',
        'crntFcstTime/GetCrntFcstTimeApiService': '/api/current',
        'tideFcstTime/GetTideFcstTimeApiService': '/api/tide-time',
        'crntFcstFldEbb/GetCrntFcstFldEbbApiService': '/api/current-fld-ebb',
        'fcstFishingv2/GetFcstFishingApiServicev2': '/api/fishing-index',
    };

    // 클라이언트 캐시 TTL (ms): 실측 데이터=10분, 예보=1시간
    const CLIENT_CACHE_TTL = {
        '/api/tide-level': 10 * 60 * 1000,
        '/api/tide-hilo': 60 * 60 * 1000,
        '/api/tide-time': 60 * 60 * 1000,
        '/api/current': 10 * 60 * 1000,
        '/api/current-fld-ebb': 60 * 60 * 1000,
        '/api/fishing-index': 60 * 60 * 1000,
    };

    function _getClientCache(key) {
        try {
            const raw = sessionStorage.getItem(key);
            if (!raw) return null;
            const { data, ts, ttl } = JSON.parse(raw);
            if (Date.now() - ts < ttl) return data;
            sessionStorage.removeItem(key);
        } catch(e) { try { sessionStorage.removeItem(key); } catch(_) {} }
        return null;
    }

    function _setClientCache(key, data, ttl) {
        try {
            sessionStorage.setItem(key, JSON.stringify({ data, ts: Date.now(), ttl }));
        } catch(e) { /* sessionStorage 용량 초과 등 무시 */ }
    }

    async function apiCall(path, params) {
        const endpoint = PROXY_ENDPOINT_MAP[path];
        if (!endpoint) throw new Error(`Unknown API path: ${path}`);

        // 클라이언트 캐시 조회
        const cacheKey = `tc_${endpoint}_${JSON.stringify(params || {})}`;
        const cached = _getClientCache(cacheKey);
        if (cached) return cached;

        const url = new URL(`${API_BASE}${endpoint}`);
        Object.entries(params || {}).forEach(([k, v]) => {
            if (v == null || v === '') return;
            url.searchParams.set(k, String(v));
        });

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 15000);

        // fetchAll 취소 시 이 요청도 함께 abort (#18+#19)
        let onParentAbort;
        if (_fetchAllController) {
            if (_fetchAllController.signal.aborted) { clearTimeout(timeoutId); throw new DOMException('Aborted', 'AbortError'); }
            onParentAbort = () => controller.abort();
            _fetchAllController.signal.addEventListener('abort', onParentAbort, { once: true });
        }

        let resp;
        try {
            resp = await fetch(url.toString(), {
                signal: controller.signal,
            });
        } finally {
            clearTimeout(timeoutId);
            if (onParentAbort && _fetchAllController) _fetchAllController.signal.removeEventListener('abort', onParentAbort);
        }
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const ct = resp.headers.get('content-type') || '';
        if (!ct.includes('json')) throw new Error('잘못된 응답 형식');
        const json = await resp.json();

        const resultCode = json?.header?.resultCode || json?.response?.header?.resultCode || null;
        const resultMsg = json?.header?.resultMsg || json?.response?.header?.resultMsg || null;
        if (resultCode && resultCode !== '00') {
            throw new Error(resultMsg || 'API 오류');
        }
        const items = json?.body?.items?.item
            || json?.response?.body?.items?.item
            || json?.result?.data
            || [];
        const result = Array.isArray(items) ? items : [items];

        // 클라이언트 캐시 저장
        const ttl = CLIENT_CACHE_TTL[endpoint] || 10 * 60 * 1000;
        _setClientCache(cacheKey, result, ttl);

        return result;
    }

    async function apiCallRaw(endpoint, params) {
        const url = new URL(`${API_BASE}${endpoint}`);
        Object.entries(params || {}).forEach(([k, v]) => {
            if (v == null || v === '') return;
            url.searchParams.set(k, String(v));
        });

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 15000);

        // fetchAll 취소 시 이 요청도 함께 abort (#18+#19)
        let onParentAbort;
        if (_fetchAllController) {
            if (_fetchAllController.signal.aborted) { clearTimeout(timeoutId); throw new DOMException('Aborted', 'AbortError'); }
            onParentAbort = () => controller.abort();
            _fetchAllController.signal.addEventListener('abort', onParentAbort, { once: true });
        }

        let resp;
        try {
            resp = await fetch(url.toString(), {
                signal: controller.signal,
            });
        } finally {
            clearTimeout(timeoutId);
            if (onParentAbort && _fetchAllController) _fetchAllController.signal.removeEventListener('abort', onParentAbort);
        }
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const ct = resp.headers.get('content-type') || '';
        if (!ct.includes('json')) throw new Error('잘못된 응답 형식');
        return await resp.json();
    }

    // ==================== FETCH ALL ====================
    function _setNavLoading(loading) {
        ['btnPrev', 'btnNext', 'btnToday'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.disabled = loading;
        });
    }

    // batch-tide API로 고저조+실측+예측을 1회 요청으로 가져오기 (fallback: 개별 호출)
    async function fetchBatchTide(stationCode, dateStr) {
        try {
            const resp = await apiCallRaw(`/api/batch-tide?obsCode=${encodeURIComponent(stationCode)}&reqDate=${encodeURIComponent(dateStr)}`);
            if (!resp || (!resp.hilo && !resp.survey && !resp.tideTime)) throw new Error('빈 batch 응답');
            const extract = (d) => {
                if (!d) return null;
                const items = d?.body?.items?.item || d?.response?.body?.items?.item || d?.result?.data;
                if (!items) return null;
                const arr = Array.isArray(items) ? items : [items];
                return arr.length > 0 ? arr : null;
            };
            return {
                hilo: extract(resp.hilo),
                survey: extract(resp.survey),
                tideTime: extract(resp.tideTime),
            };
        } catch(e) {
            console.warn('[batch-tide] fallback to individual calls:', e.message);
            return null; // fallback 신호
        }
    }

    async function fetchAll() {
        // #18+#19: 이전 fetchAll 진행 중이면 취소 (날짜 빠른 변경 시 중복 방지)
        if (_fetchAllController) _fetchAllController.abort();
        _fetchAllController = new AbortController();
        const myController = _fetchAllController;

        _setNavLoading(true);
        let chartLoadDone = false;
        setTideChartLoadStatus('loading');

        // 물때 스피너: 고저조+유속만 연동 (조위 그래프와 독립)
        const mulddaeBtn = document.getElementById('mulddaeReloadBtn');
        if (mulddaeBtn) { mulddaeBtn.disabled = true; mulddaeBtn.classList.add('is-spinning'); }

        const stationCode = getStation();
        const dateStr = getDateStr();

        // batch API + 유속: 동시 시작
        const batchPromise = fetchBatchTide(stationCode, dateStr);
        const currentPromise = fetchCurrentData().catch(e => {
            if (e && e.name === 'AbortError') return; // 취소된 요청은 무시
            console.warn('[fetchAll] 유속 로딩 실패:', e);
        });

        // 고저조 + 유속: 동시 시작 (batch 실패 시 개별 호출용 프리페치도 준비)
        let hlPromise;
        let predictionAPIs;

        try {
            const timeout = new Promise((_, reject) => {
                const tid = setTimeout(() => {
                    myController.abort();  // #18: 타임아웃 시 실제 in-flight 요청도 취소
                    reject(new Error('요청 시간 초과'));
                }, 30000);
                // 새 fetchAll 호출로 abort된 경우 타이머 정리
                myController.signal.addEventListener('abort', () => clearTimeout(tid), { once: true });
            });
            await Promise.race([
                (async () => {
                    const batchResult = await batchPromise;

                    if (batchResult && batchResult.hilo) {
                        // batch 성공: hilo 데이터로 fetchTideHighLow 대체
                        hlPromise = fetchTideHighLow(batchResult.hilo);
                        await hlPromise;
                    } else {
                        // fallback: 개별 호출
                        predictionAPIs = [
                            apiCall('surveyTideLevel/GetSurveyTideLevelApiService', {
                                obsCode: stationCode, reqDate: dateStr, min: '10', numOfRows: '300', pageNo: '1'
                            }),
                            apiCall('tideFcstTime/GetTideFcstTimeApiService', {
                                obsCode: stationCode, reqDate: dateStr, min: '10', numOfRows: '300', pageNo: '1'
                            }),
                        ];
                        hlPromise = fetchTideHighLow();
                        await hlPromise;
                    }

                    // 점진적 렌더링: 고저조 보간 곡선으로 즉시 프리뷰 표시
                    const hlData = _hlData || [];
                    if (hlData.length >= 2) {
                        const interp = interpolateFromHiLo(hlData);
                        const timeFilter = (lbl) => lbl >= '05:00' && lbl <= '18:00';
                        const fIdx = interp.labels.map((l, i) => timeFilter(l) ? i : -1).filter(i => i >= 0);
                        const fLabels = fIdx.map(i => interp.labels[i]);
                        const fPredicted = fIdx.map(i => interp.predicted[i]);
                        _chartData = { labels: fLabels, predicted: fPredicted, actual: null, annotations: {} };
                        renderTideChart(fLabels, fPredicted, null, {});
                    }

                    if (batchResult) {
                        // batch 성공: survey/tideTime 데이터를 직접 전달
                        const surveyItems = batchResult.survey || [];
                        const tideTimeItems = batchResult.tideTime || [];
                        await fetchTidePrediction([
                            Promise.resolve(surveyItems),
                            Promise.resolve(tideTimeItems),
                        ]);
                    } else {
                        await fetchTidePrediction(predictionAPIs);
                    }
                    renderCombinedChart();
                })(),
                timeout
            ]);
            chartLoadDone = true;
        } catch(e) {
            // #19: 새 fetchAll에 의해 대체된 경우 조용히 종료
            if (myController !== _fetchAllController) return;
            if (e && e.name === 'AbortError') return;

            console.error(e);
            if (e.message === '요청 시간 초과') {
                const summaryEl = document.getElementById('tideSummary');
                if (summaryEl) summaryEl.innerHTML = '<div class="error-msg">요청 시간이 초과되었습니다. 다시 시도해주세요.</div>';
            }
            setTideChartLoadStatus('error');
        }
        finally {
            // 대체된 호출이면 UI 정리 스킵
            if (myController !== _fetchAllController) return;
            if (chartLoadDone) setTideChartLoadStatus('done');
            _setNavLoading(false);
            // 에러 시에도 물때 스피너 확실히 해제
            if (mulddaeBtn) { mulddaeBtn.disabled = false; mulddaeBtn.classList.remove('is-spinning'); }
        }

        // 물때 스피너: 고저조+유속 둘 다 완료 시 해제 (조위 그래프 무관)
        Promise.allSettled([hlPromise, currentPromise]).then(() => {
            if (myController !== _fetchAllController) return; // 대체된 호출이면 무시
            if (mulddaeBtn) { mulddaeBtn.disabled = false; mulddaeBtn.classList.remove('is-spinning'); }
        });

        // 유속이 차트보다 늦게 도착하면 차트에 유속 라인 추가
        currentPromise.then(() => {
            if (myController !== _fetchAllController) return; // 대체된 호출이면 무시
            if (chartLoadDone) renderCombinedChart();
        });
    }

    // ==================== 1) 고저조 (tideFcstHghLw) ====================
    async function fetchTideHighLow(prefetchedItems) {
        const summaryEl = document.getElementById('tideSummary');
        summaryEl.innerHTML = '<div class="loading"><div class="spinner"></div><div>고저조 데이터 로딩...</div></div>';
        setTideDataStamp('예보 생성시각 조회 중');

        try {
            const stationCode = getStation();
            const dateStr = getDateStr();
            _fishingIndexInfo = null;
            const items = prefetchedItems || await apiCall('tideFcstHghLw/GetTideFcstHghLwApiService', {
                obsCode: stationCode,
                reqDate: dateStr,
                numOfRows: '20',
                pageNo: '1'
            });
            const fishingPromise = fetchFishingIndexInfo(stationCode, dateStr).catch(() => null);

            if (!items || items.length === 0) {
                setTideDataStamp('예보 생성시각 -');
                summaryEl.innerHTML = '<div class="error-msg">데이터가 없습니다.</div>';
                return;
            }

            const datePrefix = `${dateStr.substring(0,4)}-${dateStr.substring(4,6)}-${dateStr.substring(6,8)}`;
            const todayItems = items.filter(i => i.predcDt && i.predcDt.startsWith(datePrefix));
            const displayItems = todayItems.length > 0 ? todayItems : items.slice(0, 4);
            const filteredItems = displayItems.filter(i => {
                const time = i.predcDt.substring(11, 16);
                return time >= '05:00' && time <= '18:00';
            });

            const highs = filteredItems.filter(i => parseInt(i.extrSe) % 2 === 1 && i.predcTdlvVl != null);
            const lows = filteredItems.filter(i => parseInt(i.extrSe) % 2 === 0 && i.predcTdlvVl != null);

            const maxHigh = highs.length > 0 ? safeMax(highs.map(h => parseFloat(h.predcTdlvVl))) : null;
            const minLow = lows.length > 0 ? safeMin(lows.map(l => parseFloat(l.predcTdlvVl))) : null;
            const diff = (maxHigh !== null && minLow !== null) ? maxHigh - minLow : null;

            const bestHigh = highs.length > 0 ? highs.reduce((a, b) => parseFloat(a.predcTdlvVl) > parseFloat(b.predcTdlvVl) ? a : b) : null;
            const bestLow = lows.length > 0 ? lows.reduce((a, b) => parseFloat(a.predcTdlvVl) < parseFloat(b.predcTdlvVl) ? a : b) : null;

            // 물때 카드: 고정 MIN/MAX로 즉시 렌더 (fallback)
            const rangePct = calcRangeFlowPct(diff, stationCode);
            mulddaeCardState = {
                dateStr,
                stationCode,
                mulddaeBase: getMulddaeInfo(dateStr),
                diff,
                rangePct
            };
            renderMulddaeCardFromState();

            // 백그라운드: ±15일 동적 MIN/MAX 로 재계산 (non-blocking)
            (async () => {
                try {
                    let rangeData = getCachedTidalDiffs(stationCode, dateStr);
                    if (!rangeData) {
                        rangeData = await fetchLunarMonthDiffs(stationCode, dateStr);
                        if (rangeData) setCachedTidalDiffs(stationCode, dateStr, rangeData);
                    }
                    if (rangeData && mulddaeCardState && mulddaeCardState.dateStr === dateStr && mulddaeCardState.stationCode === stationCode) {
                        const dynamicPct = calcRangeFlowPct(diff, stationCode, rangeData);
                        if (dynamicPct != null) {
                            mulddaeCardState.rangePct = dynamicPct;
                            renderMulddaeCardFromState();
                        }
                    }
                } catch (e) {
                    console.warn('동적 조차 범위 fetch 실패, 고정 MIN/MAX 유지:', e.message);
                }
            })();

            const fishingInfo = await fishingPromise;
            setTideDataStamp(buildTideDataStampText(items, dateStr));
            _fishingIndexInfo = fishingInfo;
            renderMulddaeCardFromState();
            // 일출/일몰 계산
            const sunTimes = getSunTimesForStation(dateStr, stationCode);

            summaryEl.innerHTML = `
                <div class="tide-summary">
                    <div class="tide-item high">
                        <div class="label">최고조위</div>
                        <div class="value">${maxHigh !== null ? maxHigh.toFixed(0) : '-'}<small class="unit-sm"> cm</small></div>
                        <div class="time">${bestHigh ? bestHigh.predcDt.substring(11, 16) : '-'}</div>
                    </div>
                    <div class="tide-item low">
                        <div class="label">최저조위</div>
                        <div class="value">${minLow !== null ? minLow.toFixed(0) : '-'}<small class="unit-sm"> cm</small></div>
                        <div class="time">${bestLow ? bestLow.predcDt.substring(11, 16) : '-'}</div>
                    </div>
                    <div class="tide-item diff">
                        <div class="label">조차 (고저차)</div>
                        <div class="value">${diff !== null ? diff.toFixed(0) : '-'}<small class="unit-sm"> cm</small></div>
                        <div class="time"></div>
                    </div>
                </div>`;

            _hlData = displayItems;
        } catch(e) {
            setTideDataStamp('예보 생성시각 -');
            summaryEl.innerHTML = `<div class="error-msg">고저조 오류: ${escapeHTML(e.message)}</div>`;
        }
    }

    // ==================== 2) 10분 단위 조위 그래프 (surveyTideLevel) ====================
    // 고저조 포인트 사이를 코사인 보간으로 연결하여 예측 곡선 생성
    function interpolateFromHiLo(hlData) {
        if (!hlData || hlData.length < 2) return { labels: [], predicted: [] };

        // 고저조 포인트를 분 단위 타임스탬프로 변환
        const points = hlData.map(item => {
            const time = item.predcDt.substring(11, 16);
            const [h, m] = time.split(':').map(Number);
            return { min: h * 60 + m, val: parseFloat(item.predcTdlvVl) };
        }).sort((a, b) => a.min - b.min);

        // 10분 간격으로 00:00~23:50 라벨 생성
        const labels = [];
        const predicted = [];
        for (let t = 0; t < 24 * 60; t += 10) {
            const hh = String(Math.floor(t / 60)).padStart(2, '0');
            const mm = String(t % 60).padStart(2, '0');
            labels.push(`${hh}:${mm}`);

            // 현재 시각이 어느 두 포인트 사이에 있는지 찾기
            let val = null;
            if (t <= points[0].min) {
                // 첫 포인트 이전: 첫 포인트 값 유지
                val = points[0].val;
            } else if (t >= points[points.length - 1].min) {
                // 마지막 포인트 이후: 마지막 값 유지
                val = points[points.length - 1].val;
            } else {
                for (let i = 0; i < points.length - 1; i++) {
                    if (t >= points[i].min && t <= points[i + 1].min) {
                        const ratio = (t - points[i].min) / (points[i + 1].min - points[i].min);
                        // 코사인 보간: 자연스러운 조위 곡선
                        const cosRatio = (1 - Math.cos(ratio * Math.PI)) / 2;
                        val = points[i].val + (points[i + 1].val - points[i].val) * cosRatio;
                        break;
                    }
                }
            }
            predicted.push(val !== null ? Math.round(val * 10) / 10 : null);
        }
        return { labels, predicted };
    }

    function toFiniteNumber(v) {
        const n = parseFloat(v);
        return Number.isFinite(n) ? n : null;
    }

    function normalizeClockTime(raw) {
        if (raw == null) return null;
        const s = String(raw).trim();
        if (!s) return null;

        let m = s.match(/(\d{2}):(\d{2})/);
        if (m) return `${m[1]}:${m[2]}`;

        // YYYYMMDDHHMM[SS] 형태
        m = s.match(/(?:^|\D)\d{8}(\d{2})(\d{2})(?:\d{2})?(?:\D|$)/);
        if (m) return `${m[1]}:${m[2]}`;

        // HHMM 형태(다른 숫자열 사이가 아닌 토큰)
        m = s.match(/(?:^|\D)(\d{2})(\d{2})(?:\D|$)/);
        if (m) return `${m[1]}:${m[2]}`;

        // ...HHMM 으로 끝나는 긴 숫자열 fallback
        m = s.match(/(\d{2})(\d{2})(?:\d{2})?$/);
        if (m) return `${m[1]}:${m[2]}`;

        const short = s.match(/^(\d{1,2}):(\d{2})$/);
        if (short) return `${String(parseInt(short[1], 10)).padStart(2, '0')}:${short[2]}`;

        return null;
    }

    function extractCurrentTimeLabel(item) {
        if (!item || typeof item !== 'object') return null;

        const direct = normalizeClockTime(extractByKeysCaseInsensitive(item, [
            'predcDt', 'predcTm', 'predcTime', 'tm', 'dateTime', 'obsrvnDt'
        ]));
        if (direct) return direct;

        const keys = Object.keys(item);
        for (const k of keys) {
            const lk = k.toLowerCase();
            if (!(lk.includes('pred') || lk.includes('obs'))) continue;
            if (!(lk.includes('dt') || lk.endsWith('tm') || lk.includes('time'))) continue;
            const t = normalizeClockTime(item[k]);
            if (t) return t;
        }
        for (const k of keys) {
            const lk = k.toLowerCase();
            if (!(lk.includes('dt') || lk.endsWith('tm') || lk.includes('time'))) continue;
            const t = normalizeClockTime(item[k]);
            if (t) return t;
        }
        return null;
    }

    function dedupeCurrentItems(items) {
        const seen = new Set();
        const out = [];
        (items || []).forEach((item, idx) => {
            const t = extractCurrentTimeLabel(item);
            const s = toFiniteNumber(extractByKeysCaseInsensitive(item, ['crsp', 'speed', 'spd']));
            const d = extractByKeysCaseInsensitive(item, ['crdir', 'direction', 'dir']) || '';
            const key = t
                ? `${t}|${Number.isFinite(s) ? s.toFixed(3) : ''}|${String(d)}`
                : `idx:${idx}`;
            if (seen.has(key)) return;
            seen.add(key);
            out.push(item);
        });
        return out;
    }

    function parseDateTimeToken(raw, fallbackDateStr = '') {
        if (raw == null) return null;
        const s = String(raw).trim();
        if (!s) return null;

        let m = s.match(/(\d{4})[-./]?(\d{2})[-./]?(\d{2})[ T]?(\d{2}):?(\d{2})(?::?(\d{2}))?/);
        if (m) {
            const y = m[1];
            const mo = m[2];
            const d = m[3];
            const h = m[4];
            const mi = m[5];
            const sec = m[6] || '00';
            return {
                sortKey: Number(`${y}${mo}${d}${h}${mi}${sec}`),
                dateLabel: `${y}.${mo}.${d}`,
                timeLabel: `${h}:${mi}`,
                fullLabel: `${y}.${mo}.${d} ${h}:${mi}`
            };
        }

        m = s.match(/(?:^|\D)(\d{8})(\d{4})(\d{0,2})(?:\D|$)/);
        if (m) {
            const ymd = m[1];
            const hm = m[2];
            const sec = (m[3] || '00').padStart(2, '0');
            const y = ymd.substring(0, 4);
            const mo = ymd.substring(4, 6);
            const d = ymd.substring(6, 8);
            const h = hm.substring(0, 2);
            const mi = hm.substring(2, 4);
            return {
                sortKey: Number(`${y}${mo}${d}${h}${mi}${sec}`),
                dateLabel: `${y}.${mo}.${d}`,
                timeLabel: `${h}:${mi}`,
                fullLabel: `${y}.${mo}.${d} ${h}:${mi}`
            };
        }

        const t = normalizeClockTime(s);
        if (t && /^\d{8}$/.test(fallbackDateStr || '')) {
            const y = fallbackDateStr.substring(0, 4);
            const mo = fallbackDateStr.substring(4, 6);
            const d = fallbackDateStr.substring(6, 8);
            const h = t.substring(0, 2);
            const mi = t.substring(3, 5);
            return {
                sortKey: Number(`${y}${mo}${d}${h}${mi}00`),
                dateLabel: `${y}.${mo}.${d}`,
                timeLabel: `${h}:${mi}`,
                fullLabel: `${y}.${mo}.${d} ${h}:${mi}`
            };
        }
        return null;
    }

    function pickLatestDateTimeFromItems(items, keys, fallbackDateStr = '') {
        if (!items || items.length === 0) return null;
        let best = null;
        for (const item of items) {
            const raw = extractByKeysCaseInsensitive(item, keys);
            const parsed = parseDateTimeToken(raw, fallbackDateStr);
            if (!parsed) continue;
            if (!best || parsed.sortKey > best.sortKey) best = parsed;
        }
        return best;
    }

    function buildTideDataStampText(hlItems, dateStr) {
        const forecastRef = pickLatestDateTimeFromItems(
            hlItems,
            ['predcDt', 'predcTm', 'predcTime', 'tm'],
            dateStr
        );

        const forecastText = forecastRef ? forecastRef.timeLabel : '-';
        return `예보 생성시각 ${forecastText}`;
    }

    function setTideDataStamp(text) {
        const el = document.getElementById('tideDataStamp');
        if (!el) return;
        el.textContent = text || '예보 생성시각 -';
    }

    function setTideChartLoadStatus(state, text) {
        const wrap = document.getElementById('tideChartLoadStatus');
        const label = document.getElementById('tideChartLoadText');
        const btn = document.getElementById('tideChartReloadBtn');
        if (!wrap || !label) return;

        wrap.classList.remove('is-loading', 'is-done', 'is-error');

        const statusMap = {
            idle: text || '대기',
            loading: text || '로딩중...',
            done: text || '로딩완료',
            error: text || '로딩실패'
        };
        label.textContent = statusMap[state] || statusMap.idle;

        if (state === 'loading') wrap.classList.add('is-loading');
        else if (state === 'done') wrap.classList.add('is-done');
        else if (state === 'error') wrap.classList.add('is-error');

        if (btn) {
            const isLoading = state === 'loading';
            btn.disabled = isLoading;
            btn.classList.toggle('is-spinning', isLoading);
        }
        // 물때 새로고침 버튼은 fetchAll()에서 직접 제어 (카드 로딩 완료 시 즉시 해제)
    }

    async function refreshTideChart() {
        if (tideChartReloading) return;
        tideChartReloading = true;
        setTideChartLoadStatus('loading');
        try {
            // 프리페치: 고저조와 동시에 예측 API 2개 병렬 시작
            const stationCode = getStation();
            const dateStr = getDateStr();
            const predictionAPIs = [
                apiCall('surveyTideLevel/GetSurveyTideLevelApiService', {
                    obsCode: stationCode, reqDate: dateStr, min: '10', numOfRows: '300', pageNo: '1'
                }),
                apiCall('tideFcstTime/GetTideFcstTimeApiService', {
                    obsCode: stationCode, reqDate: dateStr, min: '10', numOfRows: '300', pageNo: '1'
                }),
            ];

            const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('요청 시간 초과')), 30000));
            await Promise.race([
                (async () => {
                    await fetchTideHighLow();
                    await fetchTidePrediction(predictionAPIs);
                    renderCombinedChart();
                })(),
                timeout
            ]);
            setTideChartLoadStatus('done');
        } catch (e) {
            console.error('그래프 새로고침 오류:', e);
            setTideChartLoadStatus('error');
        } finally {
            tideChartReloading = false;
        }
    }

    function extractByKeysCaseInsensitive(obj, keys) {
        if (!obj || !keys || keys.length === 0) return null;
        const keyMap = {};
        Object.keys(obj).forEach((k) => { keyMap[k.toLowerCase()] = k; });

        for (const key of keys) {
            if (obj[key] != null && obj[key] !== '') return obj[key];
            const real = keyMap[String(key).toLowerCase()];
            if (real && obj[real] != null && obj[real] !== '') return obj[real];
        }
        return null;
    }

    function buildTimeSeriesMap(items, timeKeys, valueKeys) {
        const map = {};
        (items || []).forEach((item) => {
            const tRaw = extractByKeysCaseInsensitive(item, timeKeys);
            const vRaw = extractByKeysCaseInsensitive(item, valueKeys);
            const time = normalizeClockTime(tRaw);
            const val = toFiniteNumber(vRaw);
            if (!time || val == null) return;
            map[time] = Math.round(val * 10) / 10;
        });
        return map;
    }

    function mergePredictedWithSeriesMap(labels, predicted, seriesMap) {
        if (!labels || labels.length === 0) return predicted;
        const keys = Object.keys(seriesMap || {});
        if (keys.length === 0) return predicted;
        return labels.map((lbl, idx) => (seriesMap[lbl] != null ? seriesMap[lbl] : predicted[idx]));
    }

    function buildLabelsAndPredictedFromSeriesMap(seriesMap) {
        const keys = Object.keys(seriesMap || {}).sort();
        if (keys.length === 0) return { labels: [], predicted: [] };
        return {
            labels: keys,
            predicted: keys.map((k) => seriesMap[k]),
        };
    }

    function parseFldEbbSummary(items) {
        if (!items || items.length === 0) return null;
        const rec = items[0] || {};

        const fldTime = normalizeClockTime(extractByKeysCaseInsensitive(rec, [
            'fldTm', 'fldTime', 'floodTm', 'floodTime', 'maxFldTm', 'maxFloodTm', 'maxFloodTime', 'fldDt'
        ]));
        const ebbTime = normalizeClockTime(extractByKeysCaseInsensitive(rec, [
            'ebbTm', 'ebbTime', 'maxEbbTm', 'maxEbbTime', 'ebbDt'
        ]));
        const fldSpeed = toFiniteNumber(extractByKeysCaseInsensitive(rec, [
            'fldSpd', 'fldSpeed', 'floodSpd', 'floodSpeed', 'maxFldSpd', 'maxFloodSpd'
        ]));
        const ebbSpeed = toFiniteNumber(extractByKeysCaseInsensitive(rec, [
            'ebbSpd', 'ebbSpeed', 'maxEbbSpd'
        ]));

        if (!fldTime && !ebbTime && fldSpeed == null && ebbSpeed == null) return null;
        return { fldTime, ebbTime, fldSpeed, ebbSpeed };
    }

    function getActiveFishingPlaceName(stationCode) {
        if (_selectedPort && _selectedPort.name) return _selectedPort.name;
        const byStation = FISHING_PORTS.find((p) => p.station === stationCode);
        if (byStation && byStation.name) return byStation.name;
        let stationName = '';
        for (const r of REGIONS) {
            const hit = r.stations.find((s) => s[0] === stationCode);
            if (hit) { stationName = hit[1]; break; }
        }
        return stationName || '';
    }

    function parseFishingIndexData(items, placeName, stationCode) {
        if (!items || items.length === 0) return null;

        // 오래된 데이터 무시 (7일 이상)
        const now = new Date();
        const validItems = items.filter(it => {
            if (!it.predcYmd) return false;
            const d = new Date(it.predcYmd);
            return !isNaN(d.getTime()) && (now - d) < 7 * 24 * 60 * 60 * 1000;
        });
        if (validItems.length === 0) return null;

        // 사용자 포인트 이름과 가장 유사한 지역 찾기
        let rec = null;
        if (placeName) {
            const normPlace = placeName.replace(/\s/g, '');
            rec = validItems.find(it => it.seafsPstnNm && it.seafsPstnNm.replace(/\s/g, '') === normPlace);
            if (!rec) rec = validItems.find(it => it.seafsPstnNm && it.seafsPstnNm.includes(placeName));
            if (!rec) rec = validItems.find(it => it.seafsPstnNm && placeName.includes(it.seafsPstnNm));
        }
        // 매칭 실패 시 위치 기반 가장 가까운 항목 또는 첫 번째 항목
        if (!rec) {
            const geo = getActiveGeoPoint(stationCode);
            if (geo && Number.isFinite(geo.lat) && Number.isFinite(geo.lon)) {
                let minDist = Infinity;
                for (const it of validItems) {
                    const lat = parseFloat(it.lat);
                    const lon = parseFloat(it.lot);
                    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
                    const dist = Math.sqrt((lat - geo.lat) ** 2 + (lon - geo.lon) ** 2);
                    if (dist < minDist) { minDist = dist; rec = it; }
                }
            }
        }
        if (!rec) rec = validItems[0];

        const grade = rec.totalIndex || '';
        const tideTimeScore = rec.tdlvHrScr != null && rec.tdlvHrScr !== -999 ? String(rec.tdlvHrScr) : '';
        const name = rec.seafsPstnNm || '';
        const date = rec.predcYmd || '';
        const baseTime = rec.predcNoonSeCd || '';
        const formatRange = (min, max) => {
            if (min == null && max == null) return '';
            if (min === max || max == null) return String(min);
            if (min == null) return String(max);
            return `${min}~${max}`;
        };
        const airTemp = formatRange(rec.minArtmp, rec.maxArtmp);
        const waveHeight = formatRange(rec.minWvhgt, rec.maxWvhgt);
        const waterTemp = formatRange(rec.minWtem, rec.maxWtem);
        const windSpeed = formatRange(rec.minWspd, rec.maxWspd);

        if (!grade) return null;

        return {
            reqDate: date.replace(/-/g, ''),
            gubun: '선상',
            placeName: name,
            grade,
            tideTimeScore,
            airTemp,
            waveHeight,
            waterTemp,
            windSpeed,
            baseTime,
        };
    }

    async function fetchFishingIndexInfo(stationCode, dateStr) {
        const placeName = getActiveFishingPlaceName(stationCode);
        const items = await apiCallRaw('/api/fishing-index', { v: '2' });
        return parseFishingIndexData(items, placeName, stationCode);
    }

    function pad2(n) {
        return String(Math.max(0, Math.floor(n))).padStart(2, '0');
    }

    function getActiveGeoPoint(stationCode) {
        const selectedPort = _selectedPort;
        if (selectedPort && Number.isFinite(selectedPort.lat) && Number.isFinite(selectedPort.lon)) {
            return { lat: selectedPort.lat, lon: selectedPort.lon, name: selectedPort.name };
        }

        const portByStation = FISHING_PORTS.find((p) => p.station === stationCode);
        if (portByStation && Number.isFinite(portByStation.lat) && Number.isFinite(portByStation.lon)) {
            return { lat: portByStation.lat, lon: portByStation.lon, name: portByStation.name };
        }

        if (STATION_COORDS[stationCode]) {
            return { lat: STATION_COORDS[stationCode][0], lon: STATION_COORDS[stationCode][1], name: stationCode };
        }
        return null;
    }

    function getKhoaAreaQueryTime(dateStr) {
        const nowDateStr = getDateStr();
        if (dateStr === nowDateStr) {
            const now = getNowKST();
            const h = now.getUTCHours();
            const m = Math.floor(now.getUTCMinutes() / 10) * 10;
            return { hour: pad2(h), minute: pad2(m), label: `${pad2(h)}:${pad2(m)}` };
        }
        return { hour: '12', minute: '00', label: '12:00' };
    }

    function getKhoaAreaBounds(lat, lon) {
        const dLat = 0.10;
        const rad = lat * Math.PI / 180;
        const cosv = Math.max(Math.cos(rad), 0.35);
        const dLon = dLat / cosv;
        return {
            minX: (lon - dLon).toFixed(4),
            maxX: (lon + dLon).toFixed(4),
            minY: (lat - dLat).toFixed(4),
            maxY: (lat + dLat).toFixed(4),
        };
    }

    function findNumericValue(obj, preferredKeys, matcher) {
        if (!obj) return null;
        for (const key of preferredKeys || []) {
            const raw = extractByKeysCaseInsensitive(obj, [key]);
            const v = toFiniteNumber(raw);
            if (v != null) return { value: v, key };
        }
        for (const [k, raw] of Object.entries(obj)) {
            const lk = k.toLowerCase();
            if (!matcher(lk)) continue;
            const v = toFiniteNumber(raw);
            if (v != null) return { value: v, key: k };
        }
        return null;
    }

    function detectSpeedUnit(keyName) {
        const k = String(keyName || '').toLowerCase();
        if (k.includes('knot') || k.includes('kn')) return 'kn';
        if (k.includes('cm')) return 'cm/s';
        if (k.includes('mps') || k.includes('m_s') || k.includes('meter')) return 'm/s';
        return '';
    }

    function degToCompass(deg) {
        if (!Number.isFinite(deg)) return '';
        const dirs = ['북', '북북동', '북동', '동북동', '동', '동남동', '남동', '남남동', '남', '남남서', '남서', '서남서', '서', '서북서', '북서', '북북서'];
        const idx = Math.round((((deg % 360) + 360) % 360) / 22.5) % 16;
        return dirs[idx];
    }

    function normalizeKhoaAreaRecords(raw) {
        if (!raw) return [];
        const base = raw.result?.data != null ? raw.result.data : raw;
        if (Array.isArray(base)) return base;
        if (Array.isArray(base?.features)) return base.features;
        if (Array.isArray(base?.data)) return base.data;
        if (Array.isArray(raw.features)) return raw.features;
        return [];
    }

    function parseKhoaAreaSummary(raw) {
        const records = normalizeKhoaAreaRecords(raw);
        if (!records || records.length === 0) return null;

        const speeds = [];
        const dirs = [];
        const units = [];

        for (const rec0 of records) {
            const rec = rec0 && rec0.properties ? rec0.properties : rec0;
            if (!rec || typeof rec !== 'object') continue;

            const speedHit = findNumericValue(
                rec,
                ['crsp', 'speed', 'current_speed', 'spd', 'velocity', 'vel', 'vSpd', 'currSpd'],
                (lk) => (lk.includes('speed') || lk.includes('spd') || lk.includes('vel') || lk.includes('crsp')) && !lk.includes('dir')
            );
            const dirHit = findNumericValue(
                rec,
                ['crdir', 'direction', 'dir', 'current_dir', 'currDir'],
                (lk) => lk.includes('dir') || lk.includes('direction')
            );
            const uHit = findNumericValue(
                rec,
                ['u', 'u_component', 'uComp', 'eastVel'],
                (lk) => lk === 'u' || lk.includes('ucomp') || lk.includes('east')
            );
            const vHit = findNumericValue(
                rec,
                ['v', 'v_component', 'vComp', 'northVel'],
                (lk) => lk === 'v' || lk.includes('vcomp') || lk.includes('north')
            );

            let speedVal = speedHit ? speedHit.value : null;
            let dirDeg = dirHit ? dirHit.value : null;

            if (speedVal == null && uHit && vHit) {
                speedVal = Math.sqrt(uHit.value * uHit.value + vHit.value * vHit.value);
            }
            if (!Number.isFinite(dirDeg) && uHit && vHit) {
                dirDeg = (Math.atan2(uHit.value, vHit.value) * 180 / Math.PI + 360) % 360;
            }

            if (Number.isFinite(speedVal)) {
                speeds.push(speedVal);
                units.push(detectSpeedUnit(speedHit?.key || ''));
            }
            if (Number.isFinite(dirDeg)) {
                dirs.push(((dirDeg % 360) + 360) % 360);
            }
        }

        if (speeds.length === 0) return null;
        const avgSpeed = speeds.reduce((a, b) => a + b, 0) / speeds.length;
        const maxSpeed = safeMax(speeds);
        const unit = units.find((u) => !!u) || '';

        let dirDegAvg = null;
        if (dirs.length > 0) {
            const sinSum = dirs.reduce((s, d) => s + Math.sin(d * Math.PI / 180), 0);
            const cosSum = dirs.reduce((s, d) => s + Math.cos(d * Math.PI / 180), 0);
            dirDegAvg = (Math.atan2(sinSum, cosSum) * 180 / Math.PI + 360) % 360;
        }

        return {
            sampleCount: speeds.length,
            avgSpeed,
            maxSpeed,
            unit,
            dirDeg: dirDegAvg,
            dirText: degToCompass(dirDegAvg),
        };
    }

    async function fetchTidePrediction(prefetchedAPIs) {
        try {
            const stationCode = getStation();
            const dateStr = getDateStr();
            // prefetchedAPIs가 있으면 미리 시작된 API 결과를 대기, 없으면 직접 호출
            const [surveyResult, tideTimeResult] = await Promise.allSettled(
                prefetchedAPIs || [
                    apiCall('surveyTideLevel/GetSurveyTideLevelApiService', {
                        obsCode: stationCode,
                        reqDate: dateStr,
                        min: '10',
                        numOfRows: '300',
                        pageNo: '1'
                    }),
                    apiCall('tideFcstTime/GetTideFcstTimeApiService', {
                        obsCode: stationCode,
                        reqDate: dateStr,
                        min: '10',
                        numOfRows: '300',
                        pageNo: '1'
                    }),
                ]
            );

            const items = surveyResult.status === 'fulfilled' ? surveyResult.value : [];
            const tideTimeItems = tideTimeResult.status === 'fulfilled' ? tideTimeResult.value : [];

            const hlData = _hlData || [];
            let labels = [], predicted = [], actual = null;

            // 예측조위: 항상 고저조 보간으로 05:00~18:00 전체 곡선 생성
            if (hlData.length >= 2) {
                const interp = interpolateFromHiLo(hlData);
                labels = interp.labels;
                predicted = interp.predicted;
            }

            const tideTimeMap = buildTimeSeriesMap(
                tideTimeItems,
                ['predcDt', 'predcTm', 'predcTime', 'tm', 'dateTime'],
                ['predcTdlvVl', 'bscTdlvHgt', 'tdlvHgt', 'tdlvVl']
            );

            if (labels.length > 0) {
                // tideFcstTime(시계열 예측) > 고저조 보간
                predicted = mergePredictedWithSeriesMap(labels, predicted, tideTimeMap);
            } else {
                const fromTime = buildLabelsAndPredictedFromSeriesMap(tideTimeMap);
                if (fromTime.labels.length > 0) {
                    labels = fromTime.labels;
                    predicted = fromTime.predicted;
                }
            }

            if (items && items.length > 0 && labels.length > 0) {
                // 실측조위: API 실측값을 보간 라벨에 매핑
                const actualMap = {};
                items.forEach(d => {
                    const t = normalizeClockTime(extractByKeysCaseInsensitive(d, ['obsrvnDt', 'obsrvnTm', 'obsrvnTime', 'tm', 'dateTime', 'predcDt', 'predcTm']));
                    if (!t) return;
                    actualMap[t] = toFiniteNumber(extractByKeysCaseInsensitive(d, ['tdlvHgt', 'obsrvnTdlvHgt', 'obsTdlvHgt', 'tideLevel', 'obsTideLevel']));
                });
                actual = labels.map(lbl => actualMap[lbl] != null ? actualMap[lbl] : null);
            } else if (items && items.length > 0 && labels.length === 0) {
                // 고저조 없고 실측만 있는 경우 (fallback)
                const sortedRows = items
                    .map(d => ({
                        t: normalizeClockTime(extractByKeysCaseInsensitive(d, ['obsrvnDt', 'obsrvnTm', 'obsrvnTime', 'tm', 'dateTime', 'predcDt', 'predcTm'])),
                        p: toFiniteNumber(extractByKeysCaseInsensitive(d, ['bscTdlvHgt', 'predcTdlvVl', 'tdlvVl'])),
                        a: toFiniteNumber(extractByKeysCaseInsensitive(d, ['tdlvHgt', 'obsrvnTdlvHgt', 'obsTdlvHgt', 'tideLevel', 'obsTideLevel']))
                    }))
                    .filter(r => !!r.t)
                    .sort((a, b) => a.t.localeCompare(b.t));
                labels = sortedRows.map(r => r.t);
                predicted = sortedRows.map(r => r.p);
                actual = sortedRows.map(r => r.a);
            } else {
                actual = null;
            }

            if (!labels || labels.length === 0) {
                renderTideChart([], []); return;
            }

            // 05:00~18:00 범위만 필터링
            const timeFilter = (lbl) => lbl >= '05:00' && lbl <= '18:00';
            const filterIndices = labels.map((l, i) => timeFilter(l) ? i : -1).filter(i => i >= 0);
            const fLabels = filterIndices.map(i => labels[i]);
            const fPredicted = filterIndices.map(i => predicted[i]);
            let fActual = actual ? filterIndices.map(i => actual[i]) : null;
            // fActual 배열 길이를 fLabels와 동일하게 유지 (Chart.js 매핑 보장)

            const _fValid = fPredicted.filter(v => v != null);
            const _dataMin = _fValid.length > 0 ? safeMin(_fValid) : 0;
            const _lowTimeLabelBase = _dataMin <= 70 ? 70 : _dataMin;
            const _lowTimeLabelAdjust = _dataMin <= 70 ? 21 : 24;
            let annotations = {};
            hlData.forEach((item, idx) => {
                const time = item.predcDt.substring(11, 16);
                const nearIdx = fLabels.findIndex(l => {
                    const [h1, m1] = l.split(':').map(Number);
                    const [h2, m2] = time.split(':').map(Number);
                    return Math.abs((h1 * 60 + m1) - (h2 * 60 + m2)) <= 5;
                });
                if (nearIdx < 0) return;
                const isHigh = parseInt(item.extrSe) % 2 === 1;
                const tdlvVal = parseFloat(item.predcTdlvVl);

                annotations['hl_' + idx] = {
                    type: 'point', xValue: nearIdx, yValue: tdlvVal,
                    backgroundColor: isHigh ? 'rgba(255,107,107,0.8)' : 'rgba(78,205,196,0.8)',
                    radius: 7, borderColor: '#fff', borderWidth: 2,
                };
                annotations['hl_label_' + idx] = {
                    type: 'label', xValue: nearIdx,
                    yValue: tdlvVal,
                    yAdjust: isHigh ? 24 : -24,
                    content: `${isHigh ? '고조' : '저조'} ${tdlvVal.toFixed(0)}cm`,
                    color: isHigh ? '#ff6b6b' : '#4ecdc4',
                    font: { size: 11, weight: 'bold' },
                    z: 10,
                };
                annotations['hl_time_' + idx] = {
                    type: 'label', xValue: nearIdx,
                    yValue: isHigh ? tdlvVal : _lowTimeLabelBase,
                    yAdjust: isHigh ? -16 : _lowTimeLabelAdjust,
                    content: time,
                    color: isHigh ? '#ff6b6b' : '#4ecdc4',
                    font: { size: 10, weight: '600' },
                    z: 10,
                };
            });

            // 일출/일몰 그래프 마커
            const sunTimes = getSunTimesForStation(getDateStr(), getStation());
            _sunTimes = sunTimes;
            const isMobile = window.innerWidth <= 600;
            const chartSunEl = document.getElementById('chartSunInfo');
            if (isMobile && chartSunEl) {
                const parts = [];
                if (sunTimes.sunrise) parts.push('일출 ' + sunTimes.sunrise);
                if (sunTimes.sunset) parts.push('일몰 ' + sunTimes.sunset);
                chartSunEl.textContent = parts.join(' | ');
                chartSunEl.style.display = parts.length ? '' : 'none';
            } else if (chartSunEl) {
                chartSunEl.style.display = 'none';
            }
            // 일출 포인트: 현재 위치 마커와 유사하게 표시(오렌지, 더 작은 크기)
            if (sunTimes.sunrise) {
                const sunriseIdx = fLabels.findIndex(l => {
                    const [h1, m1] = l.split(':').map(Number);
                    const [h2, m2] = sunTimes.sunrise.split(':').map(Number);
                    return Math.abs((h1 * 60 + m1) - (h2 * 60 + m2)) <= 5;
                });
                if (sunriseIdx >= 0) {
                    const sunriseY = fPredicted[sunriseIdx] != null ? fPredicted[sunriseIdx] : 0;
                    annotations['sunrise_point'] = {
                        type: 'point', xValue: sunriseIdx, yValue: sunriseY,
                        backgroundColor: 'rgba(255,183,77,0.95)',
                        radius: 4, borderColor: '#fff', borderWidth: 1.5,
                        z: 11,
                    };
                }
            }

            // 활성도 데이터 저장 (어종 버튼용)
            _chartData = { labels: fLabels, predicted: fPredicted, actual: fActual, annotations };
            renderTideChart(fLabels, fPredicted, fActual, annotations);
        } catch(e) {
            console.error('조위 그래프 오류:', e);
            renderTideChart([], []);
        }
    }

    // ==================== 어종별 활성도 계산 ====================
    // 조위 변화율(기울기)로 조류 강도를 추정하고, 어종별 패턴에 맞춰 활성도 산출
    // 출처: 낚시 커뮤니티 종합 (바다타임, 피싱트립, 낚시춘추 등)
    //
    // 🐙 쭈꾸미: 중간~강한 조류 시 활성 ↑ (들물/날물 중반). 정조 시 활성 ↓
    // 🦑 갑오징어: 조류 흐를 때 활성 ↑ (중들물/중썰물). 정조 시 입질 끊김. 간조 전후 워킹 좋음
    // 🐙 문어: 조류 약해지는 정조 전후 활성 ↑ (초들물 황금시간). 강한 조류 시 활성 ↓

    // ── 정조/물돌이 시간 상수 (10분 간격 기준) ──
    const SLACK_HALF = 3;  // 정조: 중심 ±3 = 6포인트 = 1시간
    const TURN_LEN = 6;   // 물돌이: 6포인트 = 1시간

    // ── 어종별 pct 판정 통합 상수 ──
    // grade 색상 (한 곳에서 관리)
    const GRADE_COLORS = {
        '최상': '#69f0ae', '좋음': '#4fc3f7', '보통': '#ffa726', '비추': '#ff6b6b'
    };

    // 어종별 판정 규칙 (임계값 + 설명 통합)
    const SPECIES_RULES = {
        jjukkumi: {
            emoji: '🐙', name: '쭈꾸미',
            // 유속: 40% 이하 최상, 40~60% 보통, 60% 이상 낮음
            // 고저차: 300 이하 최상, 300~500 보통, 500 이상 낮음
            useDiff: true,
            rules: [
                { cond: (p, n) => p <= 40,                      grade: '최상', desc: (p) => `약한 조류(${Math.round(p)}%) ㅡ 최적`, mulddaeDesc: (n) => `${n} — 약한 조류, 쭈꾸미 최적!` },
                { cond: (p, n) => p > 40 && p <= 60,            grade: '보통', desc: (p) => `중간 조류(${Math.round(p)}%) ㅡ 할 만함`, mulddaeDesc: (n) => `${n} — 중간 조류, 할 만한 조건` },
                { cond: () => true,                             grade: '비추', desc: (p) => `조류 강함(${Math.round(p)}%) ㅡ 비추천`, mulddaeDesc: (n) => `${n} — 조류 강해 출조 비추천` }
            ],
            diffGrade: (diff) => {
                if (diff == null || !Number.isFinite(diff)) return null;
                if (diff <= 300)                return { grade: '최상', desc: `고저차 작음(${Math.round(diff)}cm) ㅡ 최적` };
                if (diff > 300 && diff <= 500)  return { grade: '보통', desc: `고저차 보통(${Math.round(diff)}cm) ㅡ 할 만함` };
                return { grade: '비추', desc: `고저차 큼(${Math.round(diff)}cm) ㅡ 비추천` };
            }
        },
        gapoh: {
            emoji: '🦑', name: '갑오징어',
            // 삼길포 실측 조과 기반 (2024.10~11 갑오징어 시즌)
            // Best: 조금~무시 40~60%, 고저차 300~450cm
            // Good: 조금~2물 20~56%, 고저차 240~490cm
            // SoSo: 사리 부근 70%↑ 또는 1물 약조류
            useDiff: true,
            rules: [
                { cond: (p, n) => p >= 35 && p <= 60,           grade: '최상', desc: (p) => `적정 조류(${Math.round(p)}%) ㅡ 최적`, mulddaeDesc: (n) => `${n} — 적정 조류, 갑오징어 최적!` },
                { cond: (p, n) => p >= 20 && p < 35,            grade: '보통', desc: (p) => `약한 조류(${Math.round(p)}%) ㅡ 할 만함`, mulddaeDesc: (n) => `${n} — 약한 조류, 물돌이 타임 집중` },
                { cond: (p, n) => p > 60 && p <= 70,            grade: '보통', desc: (p) => `조류 강한 편(${Math.round(p)}%) ㅡ 할 만함`, mulddaeDesc: (n) => `${n} — 조류 강한 편, 장애물 뒤 포인트 공략` },
                { cond: (p, n) => p < 20,                       grade: '비추', desc: (p) => `조류 부족(${Math.round(p)}%) ㅡ 비추천`, mulddaeDesc: (n) => `${n} — 조류 부족, 출조 비추천` },
                { cond: () => true,                             grade: '비추', desc: (p) => `조류 강함(${Math.round(p)}%) ㅡ 비추천`, mulddaeDesc: (n) => `${n} — 조류 강해 출조 비추천` }
            ],
            diffGrade: (diff) => {
                if (diff == null || !Number.isFinite(diff)) return null;
                if (diff >= 300 && diff <= 450) return { grade: '최상', desc: `고저차 적당(${Math.round(diff)}cm) ㅡ 최적` };
                if (diff >= 200 && diff < 300)  return { grade: '보통', desc: `고저차 보통(${Math.round(diff)}cm) ㅡ 할 만함` };
                if (diff > 450 && diff <= 550)  return { grade: '보통', desc: `고저차 보통(${Math.round(diff)}cm) ㅡ 할 만함` };
                if (diff > 550)                 return { grade: '비추', desc: `고저차 큼(${Math.round(diff)}cm) ㅡ 비추천` };
                return { grade: '비추', desc: `고저차 작음(${Math.round(diff)}cm) ㅡ 비추천` };
            }
        },
        muneo: {
            emoji: '🐙', name: '문어',
            // 유속: 40% 이하 최상, 40~60% 보통, 60% 이상 낮음 (쭈꾸미와 동일)
            // 고저차: 300 이하 최상, 300~500 보통, 500 이상 낮음
            useDiff: true,
            diffGroup: 'jjukkumi',
            rules: [
                { cond: (p, n) => p <= 40,                      grade: '최상', desc: (p) => `약한 조류(${Math.round(p)}%) ㅡ 최적`, mulddaeDesc: (n) => `${n} — 약한 조류, 문어 최적!` },
                { cond: (p, n) => p > 40 && p <= 60,            grade: '보통', desc: (p) => `중간 조류(${Math.round(p)}%) ㅡ 할 만함`, mulddaeDesc: (n) => `${n} — 중간 조류, 할 만한 조건` },
                { cond: () => true,                             grade: '비추', desc: (p) => `조류 강함(${Math.round(p)}%) ㅡ 비추천`, mulddaeDesc: (n) => `${n} — 조류 강해 출조 비추천` }
            ],
            diffGrade: (diff) => {
                if (diff == null || !Number.isFinite(diff)) return null;
                if (diff <= 300)                return { grade: '최상', desc: `고저차 작음(${Math.round(diff)}cm) ㅡ 최적` };
                if (diff > 300 && diff <= 500)  return { grade: '보통', desc: `고저차 보통(${Math.round(diff)}cm) ㅡ 할 만함` };
                return { grade: '비추', desc: `고저차 큼(${Math.round(diff)}cm) ㅡ 비추천` };
            }
        }
    };

    // 통합 판정 함수: 어종 키 + pct + 물때이름 + 고저차(diff) → { grade, color, desc, mulddaeDesc, diffInfo }
    function getSpeciesSuitability(speciesKey, pct, num, diff) {
        const species = SPECIES_RULES[speciesKey];
        if (!species) return null;
        for (const rule of species.rules) {
            if (rule.cond(pct, num)) {
                const mulddaeText = typeof rule.mulddaeDesc === 'function' ? rule.mulddaeDesc(num) : rule.mulddaeDesc;
                const descText = typeof rule.desc === 'function' ? rule.desc(pct) : rule.desc;
                const result = { grade: rule.grade, color: GRADE_COLORS[rule.grade], desc: descText, mulddaeDesc: mulddaeText };
                // 고저차 기반 보조 판정
                if (species.useDiff && species.diffGrade && diff != null) {
                    const dg = species.diffGrade(diff);
                    if (dg) {
                        result.diffInfo = dg;
                        result.diffColor = GRADE_COLORS[dg.grade];
                    }
                }
                return result;
            }
        }
        return null;
    }

    // 물때(몇물)별 어종 적합도 — 물때 카드에 표시
    function getSpeciesByMulddae(mulddaeNum, mulddaePct, diff) {
        return Object.entries(SPECIES_RULES).map(([key, sp]) => {
            const suit = getSpeciesSuitability(key, mulddaePct, mulddaeNum, diff);
            if (!suit) return { emoji: sp.emoji, name: sp.name, grade: '-', color: 'var(--muted)', desc: '', mulddaeDesc: '' };
            return { emoji: sp.emoji, name: sp.name, ...suit };
        });
    }

    // 선상낚시 기준 어종별 설정
    // 물돌이(Turn of Tide) = 정조→유속 전환 시작점 = 최고 피딩타임
    const SPECIES_CONFIG = {
        jjukkumi: {
            name: '쭈꾸미', emoji: '🐙', color: '#e040fb',
            legend: '🐙 쭈꾸미 — 중간 조류 시 활성 최고 | 정조에도 바닥 탐색으로 입질 있음 | 선상 조금~중물 적합'
        },
        gapoh: {
            name: '갑오징어', emoji: '🦑', color: '#ff9100',
            legend: '🦑 갑오징어 — 초들물 피딩타임 | 들물 > 날물 | 정조 시 입질감지 어려움'
        },
        muneo: {
            name: '문어', emoji: '🐙', color: '#69f0ae',
            legend: '🐙 문어 — 정조 전후 먹이활동 ↑ | 초들물 황금시간 | 강한 조류 시 은신'
        }
    };

    let activeSpecies = 'none';

    function calcTideRates(predicted) {
        const n = predicted.length;
        if (n < 2) return predicted.map(() => 0);

        // 1단계: 넓은 윈도우(전후 6포인트=1시간)로 변화율 계산
        const W = 6;
        const rawRates = [];
        for (let i = 0; i < n; i++) {
            const lo = Math.max(0, i - W);
            const hi = Math.min(n - 1, i + W);
            if (predicted[lo] != null && predicted[hi] != null && hi > lo) {
                rawRates.push((predicted[hi] - predicted[lo]) / (hi - lo));
            } else {
                rawRates.push(0);
            }
        }

        // 2단계: 이동평균 스무딩 (윈도우 9포인트)
        const SW = 9;
        const smoothed = [];
        for (let i = 0; i < n; i++) {
            let sum = 0, cnt = 0;
            for (let j = Math.max(0, i - SW); j <= Math.min(n - 1, i + SW); j++) {
                sum += rawRates[j]; cnt++;
            }
            smoothed.push(cnt > 0 ? sum / cnt : 0);
        }

        // 3단계: 정규화 (최대 절대값 기준 0~1)
        const maxAbs = Math.max(safeMax(smoothed.map(Math.abs)), 0.001);
        return smoothed.map(v => v / maxAbs);
    }

    function toggleSpecies(species) {
        activeSpecies = (activeSpecies === species) ? 'none' : species;

        // 버튼 스타일 업데이트
        document.querySelectorAll('.species-btn').forEach(btn => {
            const s = btn.dataset.species;
            if (s === activeSpecies) {
                const cfg = SPECIES_CONFIG[s];
                btn.style.background = cfg ? cfg.color + '22' : 'rgba(255,255,255,0.1)';
                btn.style.borderColor = cfg ? cfg.color : 'var(--muted)';
                btn.style.color = cfg ? cfg.color : 'var(--text)';
            } else {
                btn.style.background = 'transparent';
                btn.style.borderColor = 'var(--border)';
                btn.style.color = 'var(--muted)';
            }
        });

        // speciesLegend → 좋은/안좋은 시간대 표시 (차트 위)
        updateSpeciesTimeRanges();

        // 물때 카드에 선택된 어종 설명 업데이트
        updateMulddaeSpeciesInfo();

        // 차트 다시 그리기
        if (_chartData && _chartData.labels && _chartData.labels.length > 0) {
            const { labels, predicted, actual, annotations } = _chartData;
            renderTideChart(labels, predicted, actual, annotations);
        }
    }

    // 차트 위 speciesLegend에 물돌이 시간 및 어종 범례 표시
    function updateSpeciesTimeRanges() {
        const legendEl = document.getElementById('speciesLegend');
        if (activeSpecies === 'none' || !SPECIES_CONFIG[activeSpecies] || !_chartData) {
            legendEl.style.display = 'none';
            return;
        }
        const cfg = SPECIES_CONFIG[activeSpecies];
        const { labels, predicted } = _chartData;
        if (!predicted || predicted.length === 0) { legendEl.style.display = 'none'; return; }

        // 기존 고조/저조 annotation 위치 기반 정조/물돌이 시각 감지
        const rates = calcTideRates(predicted);
        const slackZones = [];
        const turnTimes = [];
        const anns = _chartData.annotations || {};
        const hlPoints = [];
        Object.keys(anns).forEach(key => {
            if (key.match(/^hl_\d+$/) && anns[key].xValue != null) {
                hlPoints.push(anns[key].xValue);
            }
        });
        hlPoints.sort((a, b) => a - b);
        hlPoints.forEach(center => {
            const redStart = Math.max(0, center - SLACK_HALF);
            const redEnd = Math.min(labels.length - 1, center + SLACK_HALF);
            const turnEnd = Math.min(labels.length - 1, redEnd + TURN_LEN);
            slackZones.push({ start: labels[redStart] || '', end: labels[redEnd] || '' });
            const turnRate = rates[redEnd] != null ? rates[redEnd] : 0;
            turnTimes.push({ time: labels[redEnd] || '', type: turnRate > 0 ? '들물' : '날물' });
        });

        legendEl.style.display = '';
        legendEl.innerHTML = `
            <div class="current-info-row" style="gap:8px;margin-bottom:6px;">
                <span style="color:${cfg.color};font-weight:700;font-size:0.95em;">${cfg.legend}</span>
            </div>
            ${slackZones.length > 0 ? `
            <div class="current-info-row" style="margin-top:6px;">
                <span class="current-info-label" style="color:#ff5252;">⏸ 정조 구간</span>
                <span class="info-sep">|</span>
                ${slackZones.map(z => `
                    <div class="slack-zone-item" style="background:rgba(255,82,82,0.08);border-left:3px solid #ff5252;">
                        <span class="slack-time">${z.start}~${z.end}</span>
                    </div>
                `).join('')}
            </div>` : ''}
            ${turnTimes.length > 0 ? `
            <div class="current-info-row" style="margin-top:4px;">
                <span class="current-info-label" style="color:#4caf50;">🟢 물돌이</span>
                <span class="info-sep">|</span>
                ${turnTimes.map(t => `
                    <div class="slack-zone-item" style="gap:5px;background:rgba(76,175,80,0.1);border-left:3px solid #4caf50;">
                        <span class="slack-time">${t.time}</span>
                        <span style="font-size:0.72em;color:${t.type === '들물' ? '#4fc3f7' : '#ff8a65'};font-weight:600;">→${t.type}</span>
                    </div>
                `).join('')}
            </div>` : ''}`;
    }

    // 물때 카드에 선택된 어종의 물때 기반 설명 표시
    function updateMulddaeSpeciesInfo() {
        const infoEl = document.getElementById('mulddaeSpeciesInfo');
        if (!infoEl) return;
        if (activeSpecies === 'none' || !SPECIES_CONFIG[activeSpecies]) {
            infoEl.style.display = 'none';
            return;
        }
        const cfg = SPECIES_CONFIG[activeSpecies];
        const mulddaeEl = document.getElementById('mulddaeInfo');
        if (!mulddaeEl) return;

        // 현재 물때 정보 가져오기
        const mulddae = getMulddaeInfo(getDateStr());
        if (Number.isFinite(_lastMulddaePct)) {
            mulddae.pct = _lastMulddaePct;
        }
        // 통합 판정 함수 사용 — 임계값은 SPECIES_RULES에서 한 곳 관리
        const speciesTips = {
            jjukkumi: {
                slackTip: '⏸️ 정조: 직결 채비 + 캐스팅 드래깅, 바닥 긁어 유인',
                turnTip: '🟢 물돌이: 가지줄 20~30cm 전환, 리프트&폴 액션',
                rigTip: '🎣 정조→짧은 가지줄(10cm) | 유속→긴 가지줄(20~40cm)'
            },
            gapoh: {
                slackTip: '⏸️ 정조: 섭이활동 유지되나 입질감지 극난 — 쉐이킹 후 5~10초 스테이',
                turnTip: '🟢 물돌이 15~30분이 승부! 폭발적 피딩, 빠른 템포 공략',
                rigTip: '🎣 정조→직결 채비+수평 에기 | 유속→시인성 높은 레이저 에기'
            },
            muneo: {
                slackTip: '⏸️ 정조: 먹이활동 피크! 바위틈/은신처 주변 공략',
                turnTip: '🔥 초들물(간조→만조 전환): 황금시간 — 먹이 떠올라 활발',
                rigTip: '🎣 무거운 봉돌로 바닥 밀착, 저속 드래깅'
            }
        };

        const tips = speciesTips[activeSpecies];
        if (!tips) { infoEl.style.display = 'none'; return; }
        const suit = getSpeciesSuitability(activeSpecies, mulddae.pct, mulddae.num);
        if (!suit) { infoEl.style.display = 'none'; return; }

        infoEl.style.display = '';
        infoEl.innerHTML = `
            <div class="species-info-box" style="background:${cfg.color}08;border:1px solid ${cfg.color}25;">
                <div class="species-info-header">
                    <span style="font-size:1.3em;">${cfg.emoji}</span>
                    <span class="species-info-title" style="color:${cfg.color};">${cfg.name} · 오늘 ${mulddae.num} (${mulddae.name} ${mulddae.pct}%)</span>
                </div>
                <div class="species-info-desc">${suit.mulddaeDesc}</div>
                <div class="species-tip-list">
                    <div class="species-tip" style="color:var(--muted);border-top:1px solid ${cfg.color}15;">${tips.slackTip}</div>
                    <div class="species-tip" style="color:#ffa726;">${tips.turnTip}</div>
                    <div class="species-tip" style="color:var(--muted);">${tips.rigTip}</div>
                </div>
            </div>`;
    }

    function renderTideChart(labels, predicted, actual, baseAnnotations = {}) {
        _zoneData = []; // 매 렌더링마다 초기화
        const annotations = { ...baseAnnotations };
        const canvasEl = document.getElementById('tideChart');
        if (!canvasEl) return;
        const ctx = canvasEl.getContext('2d');
        if (tideChart) tideChart.destroy();
        // 갑오징어가 아니면 모바일 정조/물돌이 텍스트 숨기기
        const _slackEl = document.getElementById('chartSlackInfo');
        if (_slackEl && activeSpecies !== 'gapoh') { _slackEl.style.display = 'none'; _slackEl.innerHTML = ''; }
        if (labels.length === 0) { tideChart = null; return; }

        const grad1 = ctx.createLinearGradient(0, 0, 0, 320);
        grad1.addColorStop(0, 'rgba(79,195,247,0.3)');
        grad1.addColorStop(1, 'rgba(79,195,247,0.02)');
        const grayGrad = ctx.createLinearGradient(0, 0, 0, 320);
        grayGrad.addColorStop(0, 'rgba(148,163,184,0.15)');
        grayGrad.addColorStop(1, 'rgba(148,163,184,0.02)');

        // 현재 시간 인덱스 (segment 색상 분리용)
        let _tideNowIdx = -1;
        const _sd = document.getElementById('dateInput').value;
        const _ts = getKSTDateStr();
        const _isFuture = _sd > _ts;  // 선택 날짜가 오늘 이후(미래)인지
        if (_sd === _ts && labels.length > 0) {
            _tideNowIdx = labels.indexOf(getKSTTimeLabel());
        }

        const datasets = [{
            label: '예측 조위 (cm)',
            data: predicted,
            borderColor: _isFuture ? 'rgba(148,163,184,0.5)' : '#4fc3f7',
            backgroundColor: _isFuture ? grayGrad : grad1,
            borderWidth: 2, fill: true, tension: 0.4, cubicInterpolationMode: 'monotone', pointRadius: 0, pointHoverRadius: 0,
            order: 0,
            segment: {
                borderColor: ctx2 => _isFuture ? 'rgba(148,163,184,0.5)' : (_tideNowIdx >= 0 && ctx2.p1DataIndex > _tideNowIdx ? 'rgba(148,163,184,0.5)' : undefined),
                backgroundColor: ctx2 => _isFuture ? grayGrad : (_tideNowIdx >= 0 && ctx2.p1DataIndex > _tideNowIdx ? grayGrad : undefined),
            },
        }];

        const normalizedActual = Array.isArray(actual)
            ? actual.map((v) => toFiniteNumber(v))
            : null;
        const hasActual = Array.isArray(normalizedActual)
            && normalizedActual.some((v) => v != null);
        const actualLineSegments = hasActual
            ? normalizedActual.reduce((cnt, v, idx, arr) => {
                if (idx === 0) return cnt;
                return (arr[idx - 1] != null && v != null) ? cnt + 1 : cnt;
            }, 0)
            : 0;
        const actualPointRadius = actualLineSegments > 0 ? 0 : 2.5;
        const actualPointHoverRadius = 0;

        if (hasActual) {
            datasets.push({
                label: '실측 조위 (cm)',
                data: normalizedActual,
                borderColor: '#ffa726',
                borderWidth: 1.5, borderDash: [4, 4],
                fill: false, tension: 0.4, cubicInterpolationMode: 'monotone', pointRadius: actualPointRadius, pointHoverRadius: actualPointHoverRadius,
                order: 1, spanGaps: false,
            });
        }

        const _pValid = predicted.filter(v => v != null);
        const _aValid = hasActual ? normalizedActual.filter(v => v != null) : [];
        const _annYValues = Object.values(annotations)
            .map(a => (a && typeof a.yValue === 'number') ? a.yValue : null)
            .filter(v => v != null);
        const _yAll = _pValid.concat(_aValid, _annYValues);

        const yScale = {
            ticks: { stepSize: 100, autoSkip: false, color: '#7a8ba3', font: { size: 11 }, callback: function(v) { return v === this.max ? ['cm', v + ''] : v + ''; }, padding: 0 },
            grid: { color: 'rgba(255,255,255,0.06)' }
        };
        if (_yAll.length > 0) {
            const _yMinAuto = safeMin(_yAll);
            const _yMaxAuto = safeMax(_yAll);
            yScale.min = Math.min(0, Math.floor(_yMinAuto / 100) * 100);
            yScale.max = Math.max(100, Math.ceil(_yMaxAuto / 100) * 100);
        } else {
            yScale.min = 0;
            yScale.max = 100;
        }

        const scales = {
            x: { ticks: { color: '#7a8ba3', maxTicksLimit: 24, font: { size: 10 }, callback: function(val, idx) { const lbl = this.getLabelForValue(val); return lbl && lbl.endsWith(':00') ? lbl : null; } }, grid: { color: 'rgba(255,255,255,0.04)' } },
            y: yScale
        };
        if (activeSpecies === 'gapoh' && _pValid.length > 0) {
            const yMax = safeMax(_pValid);
            const yMin = safeMin(_pValid);
            const yCenter = (yMax + yMin) / 2;
            // 기존 고조/저조 annotation(hl_) 위치를 그대로 사용
            const hlPoints = [];
            Object.keys(annotations).forEach(key => {
                if (key.match(/^hl_\d+$/) && annotations[key].xValue != null) {
                    hlPoints.push(annotations[key].xValue);
                }
            });
            hlPoints.sort((a, b) => a - b);

            // 각 고조/저조 중심으로 정조(1h) + 물돌이(1h) 배치
            const rates = calcTideRates(predicted);
            const isMob = window.innerWidth <= 600;
            const mobSlackTexts = [];
            const mobTurnTexts = [];
            hlPoints.forEach((center, zc) => {
                const redStart = Math.max(0, center - SLACK_HALF);
                const redEnd = Math.min(labels.length - 1, center + SLACK_HALF);
                const turnStart = redEnd;
                const turnEnd = Math.min(labels.length - 1, redEnd + TURN_LEN);

                // zone 데이터 저장 (커스텀 플러그인에서 그래프 안쪽만 채움)
                _zoneData.push(
                    { start: redStart, end: redEnd, color: 'rgba(255,105,97,0.35)', border: null },
                    { start: turnStart, end: turnEnd, color: 'rgba(100,255,218,0.35)', border: null }
                );
                if (isMob) {
                    mobSlackTexts.push((labels[redStart] || '') + '~' + (labels[redEnd] || ''));
                    const turnRate = rates[redEnd] != null ? rates[redEnd] : 0;
                    mobTurnTexts.push((labels[redEnd] || '') + '→' + (turnRate > 0 ? '들물' : '날물'));
                } else {
                    annotations['slack_label_' + zc] = {
                        type: 'label', xValue: (redStart + redEnd) / 2, yValue: yCenter,
                        content: ['⏸ 정조', labels[redStart] || '', '~', labels[redEnd] || ''], color: '#ff6961',
                        font: { size: 10, weight: 'bold' },
                        backgroundColor: 'rgba(17,29,53,0.85)',
                        padding: { top: 3, bottom: 3, left: 6, right: 6 }, borderRadius: 4,
                    };
                    annotations['turn_label_' + zc] = {
                        type: 'label', xValue: (turnStart + turnEnd) / 2, yValue: yCenter,
                        content: ['🟢 물돌이', labels[turnStart] || '', '~', labels[turnEnd] || ''], color: '#64ffda',
                        font: { size: 10, weight: 'bold' },
                        backgroundColor: 'rgba(17,29,53,0.85)',
                        padding: { top: 3, bottom: 3, left: 6, right: 6 }, borderRadius: 4,
                    };
                }
            });
            // 모바일: 그래프 위에 정조/물돌이 시간 표시
            const slackInfoEl = document.getElementById('chartSlackInfo');
            if (slackInfoEl) {
                if (isMob && mobSlackTexts.length > 0) {
                    slackInfoEl.style.display = 'flex';
                    slackInfoEl.innerHTML =
                        '<span style="padding:1px 5px;background:rgba(255,105,97,0.12);border:1px solid rgba(255,105,97,0.3);border-radius:3px;"><span style="color:#ff6961;font-weight:700;">⏸ 정조</span> ' + mobSlackTexts.map(escapeHTML).join(' · ') + '</span>' +
                        '<span style="padding:1px 5px;background:rgba(100,255,218,0.10);border:1px solid rgba(100,255,218,0.25);border-radius:3px;"><span style="color:#64ffda;font-weight:700;">🟢 물돌이</span> ' + mobTurnTexts.map(escapeHTML).join(' · ') + '</span>';
                } else {
                    slackInfoEl.style.display = 'none';
                    slackInfoEl.innerHTML = '';
                }
            }
        }

        // 현재 시간 마커 (오늘 날짜 + 05:00~18:00 범위 내) — KST 기준
        const _selDate = document.getElementById('dateInput').value;
        const _todayStr = getKSTDateStr();
        if (_selDate === _todayStr && labels.length > 0) {
            const nowLabel = getKSTTimeLabel();
            const nowIdx = labels.indexOf(nowLabel);
            if (nowIdx >= 0) {
                const nowYActual = (hasActual && normalizedActual[nowIdx] != null) ? normalizedActual[nowIdx] : null;
                const nowY = nowYActual != null ? nowYActual : (predicted[nowIdx] != null ? predicted[nowIdx] : 0);
                annotations['now_point'] = {
                    type: 'point', xValue: nowIdx, yValue: nowY,
                    backgroundColor: 'rgba(255,235,59,0.9)',
                    radius: 5, borderColor: '#fff', borderWidth: 1.5,
                };
                const _yMin = _pValid.length > 0 ? safeMin(_pValid) : 0;
                annotations['now_label'] = {
                    type: 'label', xValue: nowIdx, yValue: _yMin,
                    xAdjust: 0, yAdjust: 21,
                    content: nowLabel,
                    color: '#ffeb3b',
                    font: { size: 10, weight: 'bold' },
                };
                // 수직 점선 (포인트까지만)
                annotations['now_line'] = {
                    type: 'line', xMin: nowIdx, xMax: nowIdx,
                    yMax: nowY,
                    borderColor: 'rgba(255,235,59,0.4)',
                    borderWidth: 1, borderDash: [4, 4],
                };
                // 수평 점선: 현재위치 → 좌측 Y축까지
                annotations['now_hline'] = {
                    type: 'line',
                    xMin: 0, xMax: nowIdx,
                    yMin: nowY, yMax: nowY,
                    borderColor: 'rgba(255,167,38,0.35)',
                    borderWidth: 1.5, borderDash: [5, 4],
                };
                // 기준값 라벨 (좌측 Y축 끝)
                annotations['now_hline_val'] = {
                    type: 'label',
                    xValue: 0, yValue: nowY,
                    xAdjust: -5,
                    content: '(' + nowY.toFixed(0) + ')',
                    color: '#ffa726',
                    font: { size: 8, weight: 'bold' },
                    backgroundColor: 'rgba(17,29,53,0.85)',
                    padding: { top: 2, bottom: 2, left: 4, right: 4 },
                    borderRadius: 3,
                    position: { x: 'start' },
                };
            }
        }

        // 커스텀 플러그인: 정조/물돌이 구간을 그래프 곡선 안쪽만 채움
        const zoneFillPlugin = {
            id: 'zoneFill',
            beforeDatasetsDraw(chart) {
                if (!_zoneData || _zoneData.length === 0) return;
                const { ctx: c, chartArea, scales: { x: xScale, y: yScale } } = chart;
                const meta = chart.getDatasetMeta(0); // predicted 데이터셋
                if (!meta || !meta.data || meta.data.length === 0) return;
                c.save();
                // chartArea 밖 클립
                c.beginPath();
                c.rect(chartArea.left, chartArea.top, chartArea.right - chartArea.left, chartArea.bottom - chartArea.top);
                c.clip();
                _zoneData.forEach(zone => {
                    const startIdx = Math.max(0, Math.floor(zone.start));
                    const endIdx = Math.min(meta.data.length - 1, Math.ceil(zone.end));
                    if (startIdx >= endIdx) return;
                    // fill: 그래프 선 아래 → x축까지
                    c.beginPath();
                    const firstPt = meta.data[startIdx];
                    c.moveTo(firstPt.x, chartArea.bottom);
                    for (let i = startIdx; i <= endIdx; i++) {
                        const pt = meta.data[i];
                        if (pt) c.lineTo(pt.x, pt.y);
                    }
                    const lastPt = meta.data[endIdx];
                    c.lineTo(lastPt.x, chartArea.bottom);
                    c.closePath();
                    c.fillStyle = zone.color;
                    c.fill();
                });
                c.restore();
            }
        };

        tideChart = new Chart(ctx, {
            type: 'line',
            data: { labels, datasets },
            plugins: [zoneFillPlugin],
            options: {
                responsive: true, maintainAspectRatio: false,
                layout: { padding: { top: 24, right: 0, bottom: 4, left: 0 } },
                interaction: { intersect: false, mode: 'index' },
                plugins: {
                    legend: { display: false },
                    tooltip: { enabled: false },
                    annotation: { clip: false, drawTime: 'afterDraw', annotations }
                },
                scales
            }
        });

        // 커스텀 범례 업데이트
        const tideLegendEl = document.getElementById('tideLegend');
        if (tideLegendEl) {
            const hasNow = !!annotations['now_point'];
            const sunriseTime = (_sunTimes && _sunTimes.sunrise) ? _sunTimes.sunrise : null;
            const sunsetTime = (_sunTimes && _sunTimes.sunset) ? _sunTimes.sunset : null;
            const hasSunInfo = !!(sunriseTime || sunsetTime);
            let html = '';
            if (_isFuture) {
                html += '<span class="legend-item-lg"><span class="legend-line-lg" style="background:rgba(148,163,184,0.5);"></span><span style="color:#7a8ba3;">예측 조위</span></span>';
            } else {
                html += '<span class="legend-item-lg"><span class="legend-line-lg" style="background:#4fc3f7;"></span><span style="color:#7a8ba3;">실측 조위</span></span>';
                if (_tideNowIdx >= 0) {
                    html += '<span class="legend-item-lg"><span class="legend-line-lg" style="background:rgba(148,163,184,0.5);"></span><span style="color:#7a8ba3;">예측 조위</span></span>';
                }
            }
            if (hasNow) {
                html += '<span class="legend-item-lg"><span class="legend-dot" style="width:8px;height:8px;background:#ffeb3b;"></span><span style="color:#ffeb3b;">현재 위치</span></span>';
            }
            if (hasSunInfo) {
                const sunLabel = `${sunriseTime ? `일출 ${sunriseTime}` : ''}${(sunriseTime && sunsetTime) ? ' | ' : ''}${sunsetTime ? `일몰 ${sunsetTime}` : ''}`;
                html += `<span class="legend-item-lg"><span class="legend-dot" style="background:#ffb74d;"></span><span style="color:#ffb74d;">${sunLabel}</span></span>`;
            }
            tideLegendEl.innerHTML = html;
            tideLegendEl.style.display = 'flex';
        }

        // 시간대 정보 업데이트 (차트 위 speciesLegend)
        updateSpeciesTimeRanges();
        updateMulddaeSpeciesInfo();
    }

    // ==================== 현재 시간 마커 10분 자동 갱신 ====================
    let _nowMarkerTimer = null;
    function startNowMarkerTimer() {
        if (_nowMarkerTimer) clearInterval(_nowMarkerTimer);
        _nowMarkerTimer = setInterval(() => {
            if (!tideChart || !_chartData) return;
            const cd = _chartData;
            const selDate = document.getElementById('dateInput').value;
            if (selDate !== getKSTDateStr()) return;

            const nowLabel = getKSTTimeLabel();
            const nowIdx = cd.labels.indexOf(nowLabel);

            const ann = tideChart.options.plugins.annotation.annotations;
            // 이전 마커 제거
            delete ann['now_point'];
            delete ann['now_label'];
            delete ann['now_line'];

            if (nowIdx >= 0) {
                const nowY = cd.predicted[nowIdx] != null ? cd.predicted[nowIdx] : 0;
                ann['now_point'] = {
                    type: 'point', xValue: nowIdx, yValue: nowY,
                    backgroundColor: 'rgba(255,235,59,0.9)',
                    radius: 5, borderColor: '#fff', borderWidth: 1.5,
                };
                const _filteredT = cd.predicted.filter(v => v != null);
                const _yMinT = _filteredT.length > 0 ? safeMin(_filteredT) : 0;
                ann['now_label'] = {
                    type: 'label', xValue: nowIdx, yValue: _yMinT,
                    xAdjust: 0, yAdjust: 22,
                    content: nowLabel,
                    color: '#ffeb3b',
                    font: { size: 10, weight: 'bold' },
                };
                ann['now_line'] = {
                    type: 'line', xMin: nowIdx, xMax: nowIdx,
                    yMax: nowY,
                    borderColor: 'rgba(255,235,59,0.4)',
                    borderWidth: 1, borderDash: [4, 4],
                };
            }
            tideChart.update('none'); // 애니메이션 없이 갱신
        }, 10 * 60 * 1000); // 10분
    }
    startNowMarkerTimer();

    function getCurrentSpeedUnitLabel() {
        return currentSpeedUnit === 'kn' ? 'k/n' : 'cm/s';
    }

    function convertSpeedByUnit(speedCmps, unit = currentSpeedUnit) {
        const v = toFiniteNumber(speedCmps);
        if (v == null) return null;
        if (unit === 'kn') return v / CMPS_PER_KNOT;
        return v;
    }

    function setCurrentViewState(items, el, fldEbbSummary = null, areaSummary = null) {
        currentViewState = {
            items: Array.isArray(items) ? items : [],
            el: el || null,
            fldEbbSummary,
            areaSummary,
        };
    }

    function renderCurrentViews(items, el, fldEbbSummary = null, areaSummary = null) {
        setCurrentViewState(items, el, fldEbbSummary, areaSummary);
        renderCurrentTable(items, el, fldEbbSummary, areaSummary);
        renderCurrentChart(items);
    }

    function toggleCurrentSpeedUnit() {
        currentSpeedUnit = currentSpeedUnit === 'cm/s' ? 'kn' : 'cm/s';
        const unitLabel = '유속 (' + getCurrentSpeedUnitLabel() + ')';
        const shortLabel = getCurrentSpeedUnitLabel();
        const infoUnitEl = document.getElementById('currentInfoUnitLabel');
        if (infoUnitEl) infoUnitEl.textContent = unitLabel;
        const combinedUnitEl = document.getElementById('combinedSpeedUnitLabel');
        if (combinedUnitEl) combinedUnitEl.textContent = unitLabel;
        const chartUnitEl = document.getElementById('currentChartUnitLabel');
        if (chartUnitEl) chartUnitEl.textContent = shortLabel;
        renderCombinedChart();
        if (!currentViewState || !currentViewState.el) return;
        renderCurrentViews(
            currentViewState.items,
            currentViewState.el,
            currentViewState.fldEbbSummary,
            currentViewState.areaSummary
        );
    }

    // ==================== 3) 조류 (crntFcstTime 시계열) ====================
    async function fetchCurrentData() {
        const infoEl = document.getElementById('currentInfo');
        const cStation = getCurrentStation();
        const dateStr = getDateStr();
        const stationCode = getStation();
        if (!cStation) {
            infoEl.innerHTML = '<div class="error-msg">이 지역에는 조류 예보점이 없습니다.</div>';
            renderCurrentViews([], infoEl);
            renderMulddaeCardFromState();
            return;
        }
        infoEl.innerHTML = '<div class="loading"><div class="spinner"></div><div>조류 데이터 로딩...</div></div>';

        try {
            // 3개 API 병렬 호출 (직렬 대비 ~1~2초 단축)
            const today = new Date(); const todayStr = `${today.getFullYear()}${String(today.getMonth()+1).padStart(2,'0')}${String(today.getDate()).padStart(2,'0')}`;
            const [firstPageItems, fldEbbResult, areaResult] = await Promise.all([
                // ① 조류 시계열 (crntFcstTime)
                apiCall('crntFcstTime/GetCrntFcstTimeApiService', {
                    obsCode: cStation, reqDate: dateStr,
                    numOfRows: '300', pageNo: '1', min: '10'
                }),
                // ② 창낙조 요약 (crntFcstFldEbb)
                apiCall('crntFcstFldEbb/GetCrntFcstFldEbbApiService', {
                    obsCode: cStation, reqDate: dateStr,
                    numOfRows: '20', pageNo: '1'
                }).catch(() => null),
                // ③ 면조류 (오늘/미래만)
                (async () => {
                    const geo = getActiveGeoPoint(stationCode);
                    if (!geo || dateStr < todayStr) return null;
                    const bounds = getKhoaAreaBounds(geo.lat, geo.lon);
                    const t = getKhoaAreaQueryTime(dateStr);
                    const areaRaw = await apiCallRaw('/api/khoa/current-area', {
                        date: dateStr, hour: t.hour, minute: t.minute,
                        minX: bounds.minX, maxX: bounds.maxX,
                        minY: bounds.minY, maxY: bounds.maxY, scale: '400000'
                    });
                    const summary = parseKhoaAreaSummary(areaRaw);
                    if (summary) { summary.timeLabel = t.label; summary.areaName = geo.name; }
                    return summary;
                })().catch(() => null)
            ]);

            const fldEbbSummary = fldEbbResult ? parseFldEbbSummary(fldEbbResult) : null;
            const areaSummary = areaResult;

            if (!firstPageItems || firstPageItems.length === 0) {
                infoEl.innerHTML = '<div class="error-msg">조류 데이터가 없습니다. 예보점을 확인해주세요.</div>';
                renderCurrentViews([], infoEl, fldEbbSummary, areaSummary);
                renderMulddaeCardFromState();
                return;
            }

            let mergedItems = Array.isArray(firstPageItems) ? [...firstPageItems] : [];
            let timeTaggedItems = mergedItems.map((item) => ({ ...item, __timeLabel: extractCurrentTimeLabel(item) }));
            let withTimeItems = timeTaggedItems.filter((item) => !!item.__timeLabel);
            let timeFiltered = withTimeItems.filter((item) => (
                item.__timeLabel >= '05:00' && item.__timeLabel <= '18:00'
            ));

            // 페이지 1에 05~18시 구간이 없으면 추가 페이지 조회 후 병합 재시도
            if (timeFiltered.length === 0) {
                const extraPages = ['2', '3', '4', '5'];
                const extraResults = await Promise.all(extraPages.map((pageNo) => (
                    apiCall('crntFcstTime/GetCrntFcstTimeApiService', {
                        obsCode: cStation,
                        reqDate: dateStr,
                        numOfRows: '300',
                        pageNo,
                        min: '10'
                    }).catch(() => [])
                )));

                extraResults.forEach((chunk) => {
                    if (Array.isArray(chunk) && chunk.length > 0) mergedItems.push(...chunk);
                });
                mergedItems = dedupeCurrentItems(mergedItems);
                timeTaggedItems = mergedItems.map((item) => ({ ...item, __timeLabel: extractCurrentTimeLabel(item) }));
                withTimeItems = timeTaggedItems.filter((item) => !!item.__timeLabel);
                timeFiltered = withTimeItems.filter((item) => (
                    item.__timeLabel >= '05:00' && item.__timeLabel <= '18:00'
                ));
            }

            if (timeFiltered.length === 0) {
                if (withTimeItems.length === 0) {
                    const fallback = mergedItems.filter((_, idx) => idx % 10 === 0);
                    renderCurrentViews(fallback, infoEl, fldEbbSummary, areaSummary);
                    renderMulddaeCardFromState();
                    return;
                }
                infoEl.innerHTML = '<div class="error-msg">05:00~18:00 범위 조류 데이터가 없습니다.</div>';
                renderCurrentViews([], infoEl, fldEbbSummary, areaSummary);
                renderMulddaeCardFromState();
                return;
            }

            const tenMinuteFiltered = timeFiltered.filter((item) => {
                const time = item.__timeLabel || extractCurrentTimeLabel(item);
                if (!time) return false;
                const mm = parseInt(time.substring(3, 5), 10);
                return Number.isFinite(mm) && (mm % 10 === 0);
            });
            const filtered = tenMinuteFiltered.length > 0
                ? tenMinuteFiltered
                : timeFiltered.filter((_, idx) => idx % 10 === 0);
            renderCurrentViews(filtered, infoEl, fldEbbSummary, areaSummary);
            renderMulddaeCardFromState();

            // 백그라운드: crsp 직접 정규화 (1순위 — 조차 기반보다 정확)
            const crspSpeeds = timeFiltered.map(i => parseFloat(i.crsp) || 0).filter(s => s > 0);
            const todayMaxCrsp = crspSpeeds.length > 0 ? safeMax(crspSpeeds) : null;
            if (todayMaxCrsp != null && cStation && mulddaeCardState) {
                (async () => {
                    try {
                        const windowData = await fetchCrspWindow(cStation, dateStr);
                        if (windowData && windowData.length >= 3) {
                            const windowMaxSpeeds = windowData.map(d => d.maxCrsp);
                            const crspPct = calcCrspFlowPct(todayMaxCrsp, windowMaxSpeeds);
                            if (crspPct != null && mulddaeCardState && mulddaeCardState.dateStr === dateStr) {
                                mulddaeCardState.rangePct = crspPct;
                                renderMulddaeCardFromState();
                                console.log(`[crsp 정규화] ${cStation} ${dateStr}: todayMax=${todayMaxCrsp.toFixed(1)}, window=[${safeMin(windowMaxSpeeds).toFixed(1)}~${safeMax(windowMaxSpeeds).toFixed(1)}], pct=${crspPct}%`);
                            }
                        }
                    } catch (e) {
                        console.warn('crsp 윈도우 정규화 실패, 조차 기반 유지:', e.message);
                    }
                })();
            }
        } catch(e) {
            infoEl.innerHTML = `<div class="error-msg">조류 오류: ${escapeHTML(e.message)}</div>`;
            renderCurrentViews([], infoEl);
            renderMulddaeCardFromState();
        }
    }

    function getSpeedColor(speed, pct) {
        if (pct != null) {
            if (pct >= 76) return '#ff6b6b';
            if (pct >= 51) return '#ffa726';
            if (pct >= 26) return '#4fc3f7';
            return '#81c784';
        }
        const s = parseFloat(speed);
        if (s >= 100) return '#ff6b6b';
        if (s >= 50) return '#ffa726';
        if (s >= 20) return '#4fc3f7';
        return '#81c784';
    }

    function renderCurrentTable(items, el, fldEbbSummary = null, areaSummary = null) {
        if (!items || items.length === 0) return;
        const speeds = items.map(i => parseFloat(i.crsp) || 0);
        const maxSpeed = speeds.length > 0 ? Math.max(safeMax(speeds), 1) : 1;
        const speedUnitLabel = getCurrentSpeedUnitLabel();
        const fldText = fldEbbSummary && fldEbbSummary.fldTime ? fldEbbSummary.fldTime : '-';
        const ebbText = fldEbbSummary && fldEbbSummary.ebbTime ? fldEbbSummary.ebbTime : '-';
        const fldSpeed = fldEbbSummary && Number.isFinite(fldEbbSummary.fldSpeed) ? convertSpeedByUnit(fldEbbSummary.fldSpeed) : null;
        const ebbSpeed = fldEbbSummary && Number.isFinite(fldEbbSummary.ebbSpeed) ? convertSpeedByUnit(fldEbbSummary.ebbSpeed) : null;
        const fldSpdText = fldSpeed != null ? ` (${fldSpeed.toFixed(1)}${speedUnitLabel})` : '';
        const ebbSpdText = ebbSpeed != null ? ` (${ebbSpeed.toFixed(1)}${speedUnitLabel})` : '';
        const fldEbbLine = (fldEbbSummary && (fldEbbSummary.fldTime || fldEbbSummary.ebbTime))
            ? ` · 창/낙조 ${fldText}${fldSpdText} / ${ebbText}${ebbSpdText}`
            : '';
        const rawAreaUnit = areaSummary && areaSummary.unit ? areaSummary.unit : '';
        const areaNeedsUnitConvert = currentSpeedUnit === 'kn' && rawAreaUnit === 'cm/s';
        const areaUnit = areaNeedsUnitConvert ? 'k/n' : rawAreaUnit;
        const areaAvg = areaSummary && Number.isFinite(areaSummary.avgSpeed)
            ? (areaNeedsUnitConvert ? convertSpeedByUnit(areaSummary.avgSpeed) : areaSummary.avgSpeed)
            : null;
        const areaMax = areaSummary && Number.isFinite(areaSummary.maxSpeed)
            ? (areaNeedsUnitConvert ? convertSpeedByUnit(areaSummary.maxSpeed) : areaSummary.maxSpeed)
            : null;
        const areaAvgText = areaSummary && Number.isFinite(areaSummary.avgSpeed)
            ? `${areaAvg.toFixed(2)}${areaUnit ? areaUnit : ''}`
            : '-';
        const areaMaxText = areaSummary && Number.isFinite(areaSummary.maxSpeed)
            ? `${areaMax.toFixed(2)}${areaUnit ? areaUnit : ''}`
            : '-';
        const areaDirText = areaSummary && areaSummary.dirText ? ` ${areaSummary.dirText}` : '';
        const areaLine = areaSummary
            ? ` · 면조류 ${escapeHTML(areaSummary.areaName || '')} ${escapeHTML(areaSummary.timeLabel || '')} 평균 ${areaAvgText} / 최대 ${areaMaxText}${areaDirText} (n=${areaSummary.sampleCount})`
            : '';

        el.innerHTML = `
            <div class="current-info-header">
                예보점: <strong style="color:var(--text)">${escapeHTML(items[0]?.obsvtrNm || '-')}</strong> ·
                ${items[0]?.__timeLabel || '00:00'}~${items[items.length - 1]?.__timeLabel || '00:00'} 기준 <span style="font-size:0.9em">(총 ${items.length}건 · 10분 간격)</span>${fldEbbLine}${areaLine}
            </div>
            <div class="current-scroll">
            <table class="current-table">
                <thead><tr><th>시간</th><th>유향</th><th class="current-speed-col">유속</th><th>세기</th></tr></thead>
                <tbody>
                    ${items.map(item => {
                        const time = item.__timeLabel || extractCurrentTimeLabel(item) || '-';
                        const speed = parseFloat(item.crsp) || 0;
                        const speedDisplay = convertSpeedByUnit(speed);
                        const pct = (speed / maxSpeed) * 100;
                        const color = getSpeedColor(speed, pct);
                        return `<tr>
                            <td>${time}</td>
                            <td class="current-dir-col" style="color:${color};">${escapeHTML(item.crdir || '-')}</td>
                            <td class="current-speed-col">${speedDisplay.toFixed(1)}</td>
                            <td><div class="speed-bar-wrap"><div class="speed-bar"><div class="speed-bar-fill" style="width:${pct}%;background:${color};"></div></div><span class="speed-bar-pct">${Math.round(pct)}%</span></div></td>
                        </tr>`;
                    }).join('')}
                </tbody>
            </table>
            </div>`;
    }

    function renderCurrentChart(items) {
        const canvasEl = document.getElementById('currentChart');
        if (!canvasEl) return;
        const ctx = canvasEl.getContext('2d');
        if (currentChart) currentChart.destroy();
        if (!items || items.length === 0) { currentChart = null; return; }

        const labels = items.map(i => i.__timeLabel || extractCurrentTimeLabel(i) || '-');
        const rawSpeeds = items.map(i => parseFloat(i.crsp) || 0);
        const speeds = rawSpeeds.map((v) => convertSpeedByUnit(v));
        const speedUnitLabel = getCurrentSpeedUnitLabel();

        const gradient = ctx.createLinearGradient(0, 0, 0, 320);
        gradient.addColorStop(0, 'rgba(0,229,255,0.3)');
        gradient.addColorStop(1, 'rgba(0,229,255,0.02)');
        const grayGrad = ctx.createLinearGradient(0, 0, 0, 320);
        grayGrad.addColorStop(0, 'rgba(148,163,184,0.15)');
        grayGrad.addColorStop(1, 'rgba(148,163,184,0.02)');

        // 현재 시간 인덱스 계산
        let nowIdx = -1;
        const _selDate = document.getElementById('dateInput').value;
        const _todayStr = getKSTDateStr();
        if (_selDate === _todayStr && labels.length > 0) {
            nowIdx = labels.indexOf(getKSTTimeLabel());
        }

        // annotation 객체 생성
        const annotations = {};
        if (nowIdx >= 0 && speeds[nowIdx] != null) {
            const nowSpeed = speeds[nowIdx];
            // 노란 포인트
            annotations['now_point'] = {
                type: 'point', xValue: nowIdx, yValue: nowSpeed,
                backgroundColor: 'rgba(255,235,59,0.9)',
                radius: 5, borderColor: '#fff', borderWidth: 1.5,
            };
            // 시각 라벨 (하단)
            annotations['now_label'] = {
                type: 'label', xValue: nowIdx,
                yValue: 0,
                yAdjust: 6,
                content: labels[nowIdx],
                color: '#ffeb3b',
                font: { size: 10, weight: 'bold' },
            };
            // 수평 점선: 현재위치 → 좌측 Y축까지
            annotations['now_hline'] = {
                type: 'line',
                xMin: 0, xMax: nowIdx,
                yMin: nowSpeed, yMax: nowSpeed,
                borderColor: 'rgba(0,229,255,0.35)',
                borderWidth: 1.5, borderDash: [5, 4],
            };
            // 기준값 라벨 (좌측 Y축 끝, 값이 낮으면 포인트 위로 이동)
            const _speedMax = safeMax(speeds);
            const _yAxisMax = Math.ceil(_speedMax / 50) * 50 + 50;
            const _isNearBottom = nowSpeed < _yAxisMax * 0.15;
            annotations['now_hline_val'] = {
                type: 'label',
                xValue: _isNearBottom ? nowIdx : 0,
                yValue: nowSpeed,
                xAdjust: _isNearBottom ? -35 : -5,
                yAdjust: _isNearBottom ? -18 : 0,
                content: '(' + nowSpeed.toFixed(1) + ')',
                color: '#00e5ff',
                font: { size: 9, weight: 'bold' },
                backgroundColor: 'rgba(17,29,53,0.85)',
                padding: { top: 2, bottom: 2, left: 4, right: 4 },
                borderRadius: 3,
                position: _isNearBottom ? { x: 'center' } : { x: 'start' },
            };
        }

        // 수직 점선 플러그인 (현재 위치 → 곡선까지)
        const nowLinePlugin = {
            id: 'currentNowLine',
            afterDraw(chart) {
                if (nowIdx < 0 || speeds[nowIdx] == null) return;
                const xScale = chart.scales.x;
                const yScale = chart.scales.y;
                const x = xScale.getPixelForValue(nowIdx);
                const topY = yScale.getPixelForValue(speeds[nowIdx]);
                const bottomY = chart.chartArea.bottom;
                const c = chart.ctx;
                c.save();
                c.beginPath();
                c.setLineDash([4, 4]);
                c.strokeStyle = 'rgba(255,235,59,0.5)';
                c.lineWidth = 1.2;
                c.moveTo(x, bottomY);
                c.lineTo(x, topY);
                c.stroke();
                c.restore();
            }
        };

        currentChart = new Chart(ctx, {
            type: 'line',
            data: {
                labels,
                datasets: [{
                    label: `유속 (${speedUnitLabel})`, data: speeds,
                    borderColor: '#00e5ff', backgroundColor: gradient,
                    borderWidth: 2, fill: true, tension: 0.4,
                    pointRadius: 0, pointHoverRadius: 0,
                    segment: {
                        borderColor: ctx2 => nowIdx >= 0 && ctx2.p1DataIndex > nowIdx ? 'rgba(148,163,184,0.5)' : undefined,
                        backgroundColor: ctx2 => nowIdx >= 0 && ctx2.p1DataIndex > nowIdx ? grayGrad : undefined,
                    },
                }]
            },
            options: {
                responsive: true, maintainAspectRatio: false,
                layout: { padding: { top: 8, left: 0, right: 0 } },
                interaction: { intersect: false, mode: 'index' },
                plugins: {
                    legend: { display: false },
                    tooltip: { enabled: false },
                    annotation: { clip: false, annotations }
                },
                scales: {
                    x: { ticks: { color: '#7a8ba3', maxTicksLimit: 12, font: { size: 11 } }, grid: { color: 'rgba(255,255,255,0.04)' } },
                    y: { ticks: { color: '#7a8ba3', font: { size: 11 }, callback: v => v + '', padding: 0 }, grid: { color: 'rgba(255,255,255,0.06)' } }
                }
            },
            plugins: [nowLinePlugin]
        });
    }

    // ==================== 조위-유속 복합 그래프 ====================
    function renderCombinedChart() {
        const canvasEl = document.getElementById('combinedChart');
        if (!canvasEl) return;
        const ctx = canvasEl.getContext('2d');
        if (combinedChart) combinedChart.destroy();

        const chartData = _chartData;
        const currentData = currentViewState && currentViewState.items ? currentViewState.items : [];
        const infoEl = document.getElementById('combinedChartInfo');

        if ((!chartData || !chartData.labels || chartData.labels.length === 0) && currentData.length === 0) {
            combinedChart = null;
            if (infoEl) infoEl.textContent = '조위 또는 유속 데이터가 없습니다. 관측소와 날짜를 선택 후 조회하세요.';
            return;
        }

        // 조위 데이터 준비
        const tideLabels = chartData && chartData.labels ? chartData.labels : [];
        const tidePredicted = chartData && chartData.predicted ? chartData.predicted : [];

        // 유속 데이터 준비 (단위 변환 적용)
        const currentLabels = currentData.map(i => i.__timeLabel || extractCurrentTimeLabel(i) || '-');
        const currentSpeeds = currentData.map(i => convertSpeedByUnit(parseFloat(i.crsp) || 0));

        // 공통 시간 라벨 생성 (합집합, 정렬)
        const allLabelsSet = new Set([...tideLabels, ...currentLabels]);
        const allLabels = Array.from(allLabelsSet).sort();

        if (allLabels.length === 0) {
            combinedChart = null;
            if (infoEl) infoEl.textContent = '표시할 데이터가 없습니다.';
            return;
        }

        // 조위 데이터를 공통 라벨에 매핑
        const tideMap = {};
        tideLabels.forEach((lbl, i) => { tideMap[lbl] = tidePredicted[i]; });
        const tideValues = allLabels.map(lbl => tideMap[lbl] != null ? tideMap[lbl] : null);

        // 유속 데이터를 공통 라벨에 매핑
        const speedMap = {};
        currentLabels.forEach((lbl, i) => { speedMap[lbl] = currentSpeeds[i]; });
        const speedValues = allLabels.map(lbl => speedMap[lbl] != null ? speedMap[lbl] : null);

        const hasTide = tideValues.some(v => v != null);
        const hasSpeed = speedValues.some(v => v != null);

        // Y축 범위 계산 (datasets보다 먼저)
        const tideValid = tideValues.filter(v => v != null);
        const speedValid = speedValues.filter(v => v != null);
        const tideMin = tideValid.length > 0 ? safeMin(tideValid) : 0;
        const tideMax = tideValid.length > 0 ? safeMax(tideValid) : 100;
        const speedMax = speedValid.length > 0 ? safeMax(speedValid) : 50;

        // 현재 시간 인덱스 계산 (segment 색상 분리용, datasets 생성 전에 필요)
        let nowIdx = -1;
        const _selDate = document.getElementById('dateInput').value;
        const _todayStr = getKSTDateStr();
        const _isCombinedFuture = _selDate > _todayStr;  // 미래 날짜 여부
        if (_selDate === _todayStr && allLabels.length > 0) {
            nowIdx = allLabels.indexOf(getKSTTimeLabel());
        }

        // 조위: area fill 그라디언트 (물 표현)
        const tideGrad = ctx.createLinearGradient(0, 0, 0, 380);
        tideGrad.addColorStop(0, 'rgba(56,189,248,0.40)');
        tideGrad.addColorStop(0.5, 'rgba(56,189,248,0.12)');
        tideGrad.addColorStop(1, 'rgba(56,189,248,0.0)');

        // 예측 구간 회색 그라디언트
        const grayGrad = ctx.createLinearGradient(0, 0, 0, 380);
        grayGrad.addColorStop(0, 'rgba(148,163,184,0.12)');
        grayGrad.addColorStop(0.5, 'rgba(148,163,184,0.04)');
        grayGrad.addColorStop(1, 'rgba(148,163,184,0.0)');

        // 예측 구간용 연한 조위 그라디언트
        const tidePredGrad = ctx.createLinearGradient(0, 0, 0, 380);
        tidePredGrad.addColorStop(0, 'rgba(56,189,248,0.08)');
        tidePredGrad.addColorStop(0.5, 'rgba(56,189,248,0.03)');
        tidePredGrad.addColorStop(1, 'rgba(56,189,248,0.0)');

        const datasets = [];
        // 조위: area fill (뒤쪽 — 물 배경)
        if (hasTide) {
            datasets.push({
                label: '조위 (cm)',
                data: tideValues,
                borderColor: _isCombinedFuture ? 'rgba(56,189,248,0.2)' : '#38bdf8',
                backgroundColor: _isCombinedFuture ? tidePredGrad : tideGrad,
                borderWidth: 2.5, fill: true, tension: 0.4, cubicInterpolationMode: 'monotone',
                pointRadius: 0, pointHoverRadius: 5, pointHoverBackgroundColor: '#38bdf8', pointHoverBorderColor: '#fff', pointHoverBorderWidth: 2,
                yAxisID: 'yTide',
                order: 2,
                segment: {
                    borderColor: ctx => _isCombinedFuture ? 'rgba(56,189,248,0.2)' : (nowIdx >= 0 && ctx.p1DataIndex > nowIdx ? 'rgba(56,189,248,0.2)' : undefined),
                    backgroundColor: ctx => _isCombinedFuture ? tidePredGrad : (nowIdx >= 0 && ctx.p1DataIndex > nowIdx ? tidePredGrad : undefined),
                },
            });
        }
        // 유속: 라인 (앞쪽 — fill 없이 깔끔한 선)
        if (hasSpeed) {
            datasets.push({
                label: '유속 (' + getCurrentSpeedUnitLabel() + ')',
                data: speedValues,
                borderColor: _isCombinedFuture ? 'rgba(52,211,153,0.2)' : '#34d399',
                backgroundColor: 'transparent',
                borderWidth: 2, fill: false, tension: 0.4,
                pointRadius: 0, pointHoverRadius: 5, pointHoverBackgroundColor: '#34d399', pointHoverBorderColor: '#fff', pointHoverBorderWidth: 2,
                yAxisID: 'ySpeed',
                order: 1,
                segment: {
                    borderColor: ctx => _isCombinedFuture ? 'rgba(52,211,153,0.2)' : (nowIdx >= 0 && ctx.p1DataIndex > nowIdx ? 'rgba(52,211,153,0.2)' : undefined),
                },
            });
        }

        const scales = {
            x: {
                ticks: { color: '#94a3b8', maxTicksLimit: 14, font: { size: 10 }, maxRotation: 0, callback: function(val) { const lbl = this.getLabelForValue(val); return lbl && lbl.endsWith(':00') ? lbl : null; } },
                grid: { color: 'rgba(255,255,255,0.05)' },
                border: { color: 'rgba(255,255,255,0.08)' },
            },
        };
        if (hasTide) {
            scales.yTide = {
                type: 'linear', position: 'left', display: true,
                min: Math.min(0, Math.floor(tideMin / 100) * 100),
                max: Math.max(100, Math.ceil(tideMax / 100) * 100),
                ticks: { stepSize: 100, color: '#38bdf8', font: { size: 10 }, callback: v => v + '', padding: 0 },
                grid: { color: 'rgba(56,189,248,0.07)' },
                border: { display: false },
                title: { display: false },
            };
        }
        if (hasSpeed) {
            let rawSpeedMax, speedStep, speedAxisMax;
            if (currentSpeedUnit === 'kn') {
                rawSpeedMax = Math.ceil(speedMax) + 0.5;
                speedStep = rawSpeedMax <= 2 ? 0.5 : rawSpeedMax <= 5 ? 1 : 2;
                speedAxisMax = Math.ceil(rawSpeedMax / speedStep) * speedStep;
            } else {
                rawSpeedMax = Math.ceil(speedMax / 20) * 20 + 20;
                speedStep = rawSpeedMax <= 60 ? 10 : rawSpeedMax <= 120 ? 20 : rawSpeedMax <= 300 ? 50 : 100;
                speedAxisMax = Math.ceil(rawSpeedMax / speedStep) * speedStep;
            }
            scales.ySpeed = {
                type: 'linear', position: 'right', display: true,
                min: 0,
                max: speedAxisMax,
                ticks: { stepSize: speedStep, color: '#34d399', font: { size: 10 }, callback: v => currentSpeedUnit === 'kn' ? v.toFixed(1) : v + '', padding: 0 },
                grid: { drawOnChartArea: false },
                border: { display: false },
                title: { display: false },
            };
        }

        // 현재 시간 마커 (nowIdx는 상단에서 이미 계산됨)
        const annotations = {};
        if (nowIdx >= 0) {
            const nowLabel = allLabels[nowIdx];
            const nowTideY = tideValues[nowIdx] != null ? tideValues[nowIdx] : null;
            if (hasTide && nowTideY != null) {
                annotations['now_point'] = {
                    type: 'point', xValue: nowIdx, yValue: nowTideY,
                    backgroundColor: 'rgba(255,235,59,0.9)',
                    radius: 5, borderColor: '#fff', borderWidth: 1.5,
                    yScaleID: 'yTide',
                };
            }
            const _tValid = tideValid.length > 0 ? safeMin(tideValid) : 0;
            annotations['now_label'] = {
                type: 'label', xValue: nowIdx,
                yValue: hasTide ? _tValid : 0,
                yAdjust: 19,
                content: nowLabel,
                color: '#ffeb3b',
                font: { size: 10, weight: 'bold' },
                ...(hasTide ? { yScaleID: 'yTide' } : {}),
            };
            // 유속 값 (수직선 마감점 계산용)
            const nowSpeedRaw = speedValues[nowIdx] != null ? speedValues[nowIdx] : null;
            // 수직 점선은 커스텀 플러그인(nowLinePlugin)으로 그림 (조위~유속 포인트 사이만)
            // 유속 곡선 위 포인트
            if (hasSpeed && nowSpeedRaw != null) {
                annotations['now_point_speed'] = {
                    type: 'point', xValue: nowIdx, yValue: nowSpeedRaw,
                    backgroundColor: 'rgba(255,235,59,0.9)',
                    radius: 5, borderColor: '#fff', borderWidth: 1.5,
                    yScaleID: 'ySpeed',
                };
            }
            // 조위 수평 점선: 현재위치 → 왼쪽(조위축)까지만 (조위 색상)
            if (hasTide && nowTideY != null) {
                annotations['now_hline'] = {
                    type: 'line',
                    xMin: 0, xMax: nowIdx,
                    yMin: nowTideY, yMax: nowTideY,
                    yScaleID: 'yTide',
                    borderColor: 'rgba(56,189,248,0.35)',
                    borderWidth: 1.5, borderDash: [5, 4],
                };
                // 조위 기준값 라벨 (좌측 Y축 끝)
                annotations['now_hline_val'] = {
                    type: 'label',
                    xValue: 0,
                    yValue: nowTideY,
                    yScaleID: 'yTide',
                    xAdjust: -5,
                    content: '(' + nowTideY.toFixed(0) + ')',
                    color: '#38bdf8',
                    font: { size: 8, weight: 'bold' },
                    backgroundColor: 'rgba(17,29,53,0.85)',
                    padding: { top: 2, bottom: 2, left: 4, right: 4 },
                    borderRadius: 3,
                    position: { x: 'start' },
                };
            }
            // 유속 수평 점선: 현재위치 → 오른쪽(유속축)까지만 (유속 색상)
            if (hasSpeed && nowSpeedRaw != null) {
                annotations['now_hline_speed'] = {
                    type: 'line',
                    xMin: nowIdx, xMax: allLabels.length - 1,
                    yMin: nowSpeedRaw, yMax: nowSpeedRaw,
                    yScaleID: 'ySpeed',
                    borderColor: 'rgba(52,211,153,0.35)',
                    borderWidth: 1.5, borderDash: [5, 4],
                };
                // 유속 기준값 라벨 (우측 Y축 끝)
                annotations['now_hline_speed_val'] = {
                    type: 'label',
                    xValue: allLabels.length - 1,
                    yValue: nowSpeedRaw,
                    yScaleID: 'ySpeed',
                    xAdjust: 5,
                    content: '(' + (currentSpeedUnit === 'kn' ? nowSpeedRaw.toFixed(1) : nowSpeedRaw.toFixed(0)) + ')',
                    color: '#34d399',
                    font: { size: 8, weight: 'bold' },
                    backgroundColor: 'rgba(17,29,53,0.85)',
                    padding: { top: 2, bottom: 2, left: 4, right: 4 },
                    borderRadius: 3,
                    position: { x: 'end' },
                };
            }
        }

        // 범례에 예측 구간 표기 추가를 위한 플래그
        const hasNowSplit = nowIdx >= 0;

        // 현재 시간 수직 점선 플러그인 (조위 포인트 ~ 유속 포인트 사이만)
        const _nowIdx = nowIdx;
        const _nowTideY = (nowIdx >= 0 && tideValues[nowIdx] != null) ? tideValues[nowIdx] : null;
        const _nowSpeedY = (nowIdx >= 0 && speedValues[nowIdx] != null) ? speedValues[nowIdx] : null;
        const nowLinePlugin = {
            id: 'combinedNowLine',
            afterDraw(chart) {
                if (_nowIdx < 0) return;
                const xScale = chart.scales.x;
                const x = xScale.getPixelForValue(_nowIdx);
                const { bottom } = chart.chartArea;
                const c = chart.ctx;
                // 상단 끝점: 유속 포인트 → 조위 포인트 → 차트 하단 (fallback)
                let topY = bottom;
                if (_nowSpeedY != null && chart.scales.ySpeed) {
                    topY = chart.scales.ySpeed.getPixelForValue(_nowSpeedY);
                } else if (_nowTideY != null && chart.scales.yTide) {
                    topY = chart.scales.yTide.getPixelForValue(_nowTideY);
                }
                c.save();
                c.beginPath();
                c.moveTo(x, bottom);
                c.lineTo(x, topY);
                c.lineWidth = 1;
                c.strokeStyle = 'rgba(255,235,59,0.4)';
                c.setLineDash([4, 4]);
                c.stroke();
                c.restore();
            }
        };

        // 크로스헤어 플러그인 (호버 시 수직선)
        const crosshairPlugin = {
            id: 'combinedCrosshair',
            afterDraw(chart) {
                if (chart.tooltip && chart.tooltip._active && chart.tooltip._active.length) {
                    const x = chart.tooltip._active[0].element.x;
                    const { top, bottom } = chart.chartArea;
                    const c = chart.ctx;
                    c.save();
                    c.beginPath();
                    c.moveTo(x, top);
                    c.lineTo(x, bottom);
                    c.lineWidth = 1;
                    c.strokeStyle = 'rgba(255,255,255,0.15)';
                    c.setLineDash([4, 3]);
                    c.stroke();
                    c.restore();
                }
            }
        };

        combinedChart = new Chart(ctx, {
            type: 'line',
            data: { labels: allLabels, datasets },
            plugins: [nowLinePlugin, crosshairPlugin],
            options: {
                responsive: true, maintainAspectRatio: false,
                layout: { padding: { top: 10, right: 0, bottom: 8, left: 0 } },
                interaction: { intersect: false, mode: 'index' },
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        backgroundColor: 'rgba(10,22,40,0.92)',
                        titleColor: '#e2e8f0', titleFont: { size: 12, weight: '600' },
                        bodyColor: '#94a3b8', bodyFont: { size: 12 },
                        borderColor: 'rgba(255,255,255,0.08)', borderWidth: 1,
                        padding: { top: 10, bottom: 10, left: 14, right: 14 },
                        cornerRadius: 8,
                        displayColors: true,
                        boxWidth: 10, boxHeight: 10, boxPadding: 4,
                        callbacks: {
                            title: function(items) { return items[0] ? items[0].label : ''; },
                            label: function(c) {
                                if (c.parsed.y == null) return null;
                                if (c.dataset.yAxisID === 'yTide') return '  조위  ' + c.parsed.y.toFixed(1) + ' cm';
                                if (c.dataset.yAxisID === 'ySpeed') return '  유속  ' + c.parsed.y.toFixed(1) + ' ' + getCurrentSpeedUnitLabel();
                                return c.dataset.label + ': ' + c.parsed.y;
                            },
                            labelColor: function(c) {
                                if (c.dataset.yAxisID === 'yTide') return { borderColor: '#38bdf8', backgroundColor: '#38bdf8', borderRadius: 2 };
                                return { borderColor: '#34d399', backgroundColor: '#34d399', borderRadius: 2 };
                            }
                        }
                    },
                    annotation: { clip: false, drawTime: 'afterDraw', annotations }
                },
                scales
            }
        });

        // 범례 표시
        const legendEl = document.getElementById('combinedChartLegend');
        if (legendEl) {
            let html = '';
            if (_isCombinedFuture) {
                if (hasTide) html += '<span class="legend-item" style="gap:5px;"><span class="legend-line-xl" style="background:rgba(56,189,248,0.2);"></span><span style="color:rgba(56,189,248,0.5);font-weight:500;">예측조위</span></span>';
                if (hasSpeed) html += '<span class="legend-item" style="gap:5px;"><span class="legend-line-xl" style="background:rgba(52,211,153,0.2);"></span><span style="color:rgba(52,211,153,0.5);font-weight:500;">예측유속</span></span>';
            } else {
                if (hasTide) html += '<span class="legend-item"><span class="legend-line" style="background:#38bdf8;"></span><span style="color:#38bdf8;font-weight:500;">실측조위</span></span>';
                if (hasSpeed) html += '<span class="legend-item"><span class="legend-line" style="background:#34d399;"></span><span style="color:#34d399;font-weight:500;">실측유속</span></span>';
                if (hasNowSplit && hasTide) html += '<span class="legend-item"><span class="legend-line" style="background:rgba(56,189,248,0.2);"></span><span style="color:rgba(56,189,248,0.5);font-weight:500;">예측조위</span></span>';
                if (hasNowSplit && hasSpeed) html += '<span class="legend-item"><span class="legend-line" style="background:rgba(52,211,153,0.2);"></span><span style="color:rgba(52,211,153,0.5);font-weight:500;">예측유속</span></span>';
                if (annotations['now_point'] || annotations['now_line']) html += '<span class="legend-item"><span class="legend-dot" style="background:#ffeb3b;"></span><span style="color:#ffeb3b;font-weight:500;">현재위치</span></span>';
            }
            legendEl.innerHTML = html;
        }

        // 정보 텍스트
        if (infoEl) {
            const parts = [];
            if (!hasTide) parts.push('조위 데이터 없음');
            if (!hasSpeed) parts.push('유속 데이터 없음');
            infoEl.textContent = parts.length > 0 ? '※ ' + parts.join(', ') + ' — 조위 관측소와 조류 예보점을 확인해주세요.' : '';
        }
    }
