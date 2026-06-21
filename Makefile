CXX = clang++
CC = clang

CSMAP_DEV ?= vendor/csmap/CsMapDev
CSMAP_REPO ?= vendor/csmap
CSMAP_DICT ?= $(CSMAP_DEV)/Dictionaries
CSMAP_LIB := $(CSMAP_DEV)/lib47/Linux64/CsMap.a
CSMAP_SENTINEL := $(CSMAP_DICT)/Coordsys.CSD
CSMAP_PATCH := patches/csmap-macos-clang.patch
WEB_DIR := web
REPORT_JS := $(WEB_DIR)/report.js
LIVE_COMPARE := bin/live_compare
COMPARE_CORE := src/compare_core.cpp

WASM_DIR ?= wasm
WASM_BUILD_DIR ?= $(WASM_DIR)/build
WASM_VENDOR_DIR ?= $(WASM_DIR)/vendor
WASM_DIST_DIR ?= $(WASM_DIR)/dist
WASM_DATA_DIR ?= $(WEB_DIR)/wasm-data
PROJ_WASM_VERSION ?= 9.8.1

PROJ_CFLAGS := $(shell pkg-config --cflags proj)
PROJ_LIBS := $(shell pkg-config --libs proj)

CXXFLAGS ?= -std=c++17 -O2 -Wall -Wextra -pedantic -Wno-invalid-utf8
CPPFLAGS += -I$(CSMAP_DEV)/Include $(PROJ_CFLAGS)
LDLIBS += $(CSMAP_LIB) $(PROJ_LIBS) -lm

.PHONY: all bootstrap csmap csmap-patch csmap-test run test app serve clean proj-smoke ts-build wasm-toolchain-check wasm-data wasm wasm-test

all: bin/compare bin/parity_tests $(LIVE_COMPARE)

bootstrap:
	./scripts/bootstrap.sh

csmap: csmap-patch $(CSMAP_LIB) $(CSMAP_SENTINEL)

csmap-patch:
	@test -d "$(CSMAP_DEV)" || (echo "CS-MAP submodule is missing. Run: git submodule update --init --recursive vendor/csmap" >&2; exit 1)
	@if git -C "$(CSMAP_REPO)" apply --check --ignore-space-change "$(abspath $(CSMAP_PATCH))" >/dev/null 2>&1; then \
		git -C "$(CSMAP_REPO)" apply --ignore-space-change "$(abspath $(CSMAP_PATCH))"; \
	elif git -C "$(CSMAP_REPO)" apply --reverse --check --ignore-space-change "$(abspath $(CSMAP_PATCH))" >/dev/null 2>&1; then \
		echo "CS-MAP patch already applied."; \
	else \
		echo "CS-MAP patch does not apply cleanly. Inspect $(CSMAP_PATCH) and $(CSMAP_REPO)." >&2; \
		exit 1; \
	fi

csmap-test: csmap-patch
	$(MAKE) -C $(CSMAP_DEV) -f CsMap.mak Linux64 QuickTest CC=$(CC) CXX=$(CXX)

proj-smoke:
	projinfo EPSG:3857 >/dev/null

$(CSMAP_LIB) $(CSMAP_SENTINEL): csmap-patch
	$(MAKE) -C $(CSMAP_DEV) -f CsMap.mak Linux64 CC=$(CC) CXX=$(CXX)

bin/compare: src/compare.cpp $(CSMAP_LIB) $(CSMAP_SENTINEL) | bin
	$(CXX) $(CXXFLAGS) $(CPPFLAGS) -o $@ src/compare.cpp $(LDLIBS)

bin/parity_tests: src/parity_tests.cpp $(CSMAP_LIB) $(CSMAP_SENTINEL) | bin
	$(CXX) $(CXXFLAGS) $(CPPFLAGS) -o $@ src/parity_tests.cpp $(LDLIBS)

$(LIVE_COMPARE): src/live_compare.cpp $(COMPARE_CORE) src/compare_core.hpp $(CSMAP_LIB) $(CSMAP_SENTINEL) | bin
	$(CXX) $(CXXFLAGS) $(CPPFLAGS) -o $@ src/live_compare.cpp $(COMPARE_CORE) $(LDLIBS)

bin:
	mkdir -p bin

run: bin/compare proj-smoke
	./bin/compare --csmap-dict $(CSMAP_DICT)

test: csmap-test proj-smoke bin/parity_tests app
	./bin/parity_tests --csmap-dict $(CSMAP_DICT)

node_modules/.package-lock.json: package.json package-lock.json
	npm ci

ts-build: node_modules/.package-lock.json
	npm run build

app: $(REPORT_JS) $(LIVE_COMPARE) wasm-data ts-build

$(REPORT_JS): bin/parity_tests | $(WEB_DIR)
	./bin/parity_tests --csmap-dict $(CSMAP_DICT) --report-js $(REPORT_JS)

$(WEB_DIR):
	mkdir -p $(WEB_DIR)

serve: app
	PORT=4173 HOST=127.0.0.1 npm run serve

wasm-toolchain-check:
	./scripts/wasm-toolchain-check.sh

wasm-data: csmap
	CSMAP_DICT=$(CSMAP_DICT) WASM_DATA_DIR=$(WASM_DATA_DIR) ./scripts/wasm-data.sh

wasm: wasm-toolchain-check wasm-data
	PROJ_VERSION=$(PROJ_WASM_VERSION) WASM_DIR=$(WASM_DIR) WASM_BUILD_DIR=$(WASM_BUILD_DIR) WASM_VENDOR_DIR=$(WASM_VENDOR_DIR) ./scripts/build-wasm-proj.sh
	CSMAP_DEV=$(CSMAP_DEV) WASM_DIR=$(WASM_DIR) WASM_BUILD_DIR=$(WASM_BUILD_DIR) ./scripts/build-wasm-csmap.sh
	WASM_DIR=$(WASM_DIR) WASM_BUILD_DIR=$(WASM_BUILD_DIR) WASM_DATA_DIR=$(WASM_DATA_DIR) ./scripts/build-wasm-runtime.sh

wasm-test: wasm
	PROJ_VERSION=$(PROJ_WASM_VERSION) WASM_DIR=$(WASM_DIR) WASM_BUILD_DIR=$(WASM_BUILD_DIR) WASM_VENDOR_DIR=$(WASM_VENDOR_DIR) WASM_DATA_DIR=$(WASM_DATA_DIR) ./scripts/wasm-test.sh

clean:
	rm -rf bin $(REPORT_JS) dist $(WEB_DIR)/dist $(WEB_DIR)/wasm
