CXX = clang++
CC = clang

CSMAP_DEV ?= vendor/csmap/CsMapDev
CSMAP_DICT ?= $(CSMAP_DEV)/Dictionaries
CSMAP_LIB := $(CSMAP_DEV)/lib47/Linux64/CsMap.a
CSMAP_SENTINEL := $(CSMAP_DICT)/Coordsys.CSD
WEB_DIR := web
REPORT_JS := $(WEB_DIR)/report.js
LIVE_COMPARE := bin/live_compare

PROJ_CFLAGS := $(shell pkg-config --cflags proj)
PROJ_LIBS := $(shell pkg-config --libs proj)

CXXFLAGS ?= -std=c++17 -O2 -Wall -Wextra -pedantic -Wno-invalid-utf8
CPPFLAGS += -I$(CSMAP_DEV)/Include $(PROJ_CFLAGS)
LDLIBS += $(CSMAP_LIB) $(PROJ_LIBS) -lm

.PHONY: all bootstrap csmap csmap-test run test app serve clean proj-smoke ts-build

all: bin/compare bin/parity_tests $(LIVE_COMPARE)

bootstrap:
	./scripts/bootstrap.sh

csmap: $(CSMAP_LIB) $(CSMAP_SENTINEL)

csmap-test:
	$(MAKE) -C $(CSMAP_DEV) -f CsMap.mak Linux64 QuickTest CC=$(CC) CXX=$(CXX)

proj-smoke:
	projinfo EPSG:3857 >/dev/null

$(CSMAP_LIB) $(CSMAP_SENTINEL):
	$(MAKE) -C $(CSMAP_DEV) -f CsMap.mak Linux64 CC=$(CC) CXX=$(CXX)

bin/compare: src/compare.cpp $(CSMAP_LIB) $(CSMAP_SENTINEL) | bin
	$(CXX) $(CXXFLAGS) $(CPPFLAGS) -o $@ src/compare.cpp $(LDLIBS)

bin/parity_tests: src/parity_tests.cpp $(CSMAP_LIB) $(CSMAP_SENTINEL) | bin
	$(CXX) $(CXXFLAGS) $(CPPFLAGS) -o $@ src/parity_tests.cpp $(LDLIBS)

$(LIVE_COMPARE): src/live_compare.cpp $(CSMAP_LIB) $(CSMAP_SENTINEL) | bin
	$(CXX) $(CXXFLAGS) $(CPPFLAGS) -o $@ src/live_compare.cpp $(LDLIBS)

bin:
	mkdir -p bin

run: bin/compare proj-smoke
	./bin/compare --csmap-dict $(CSMAP_DICT)

test: csmap-test proj-smoke bin/parity_tests
	./bin/parity_tests --csmap-dict $(CSMAP_DICT)

node_modules/.package-lock.json: package.json
	npm install

ts-build: node_modules/.package-lock.json
	npm run build

app: $(REPORT_JS) $(LIVE_COMPARE) ts-build

$(REPORT_JS): bin/parity_tests | $(WEB_DIR)
	./bin/parity_tests --csmap-dict $(CSMAP_DICT) --report-js $(REPORT_JS)

$(WEB_DIR):
	mkdir -p $(WEB_DIR)

serve: app
	PORT=4173 HOST=127.0.0.1 npm run serve

clean:
	rm -rf bin $(REPORT_JS) dist $(WEB_DIR)/dist
