#include <proj.h>

#include <cmath>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <memory>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

extern "C" {
#include "cs_map.h"
}

struct Coord {
  double x;
  double y;
};

struct Sample {
  std::string name;
  Coord input;
};

struct TestCase {
  std::string name;
  std::string csmapSource;
  std::string csmapTarget;
  std::string projSource;
  std::string projTarget;
  std::string units;
  double tolerance;
  std::vector<Sample> samples;
};

struct BBox {
  double west;
  double south;
  double east;
  double north;
};

struct ExtentCase {
  std::string name;
  std::string csmapCrs;
  std::string projCrs;
  double toleranceDegrees;
};

struct TestResult {
  int assertions = 0;
  int failures = 0;
  int differences = 0;
};

static std::string optionValue(int argc, char** argv, const char* name, const char* fallback) {
  for (int i = 1; i + 1 < argc; ++i) {
    if (std::strcmp(argv[i], name) == 0) {
      return argv[i + 1];
    }
  }
  return fallback;
}

static void writeJsonString(std::ostream& out, const std::string& value) {
  out << '"';
  for (char ch : value) {
    switch (ch) {
      case '\\':
        out << "\\\\";
        break;
      case '"':
        out << "\\\"";
        break;
      case '\n':
        out << "\\n";
        break;
      case '\r':
        out << "\\r";
        break;
      case '\t':
        out << "\\t";
        break;
      default:
        out << ch;
        break;
    }
  }
  out << '"';
}

static void writeJsonNumber(std::ostream& out, double value) {
  if (std::isfinite(value)) {
    out << std::setprecision(15) << value;
  } else {
    out << "null";
  }
}

static void writeJsonCoord(std::ostream& out, const Coord& coord) {
  out << "{\"x\":";
  writeJsonNumber(out, coord.x);
  out << ",\"y\":";
  writeJsonNumber(out, coord.y);
  out << "}";
}

static void writeJsonBBox(std::ostream& out, const BBox& bbox) {
  out << "{\"west\":";
  writeJsonNumber(out, bbox.west);
  out << ",\"south\":";
  writeJsonNumber(out, bbox.south);
  out << ",\"east\":";
  writeJsonNumber(out, bbox.east);
  out << ",\"north\":";
  writeJsonNumber(out, bbox.north);
  out << "}";
}

static Coord transformWithCsMap(const TestCase& testCase, Coord input) {
  double coord[3] = {input.x, input.y, 0.0};
  int status = CS_cnvrt(testCase.csmapSource.c_str(), testCase.csmapTarget.c_str(), coord);
  if (status != 0) {
    throw std::runtime_error("CS-MAP returned status " + std::to_string(status));
  }
  if (!std::isfinite(coord[0]) || !std::isfinite(coord[1])) {
    throw std::runtime_error("CS-MAP returned a non-finite coordinate");
  }
  return {coord[0], coord[1]};
}

static BBox extentWithCsMap(const std::string& crsName) {
  cs_Csdef_* definition = CS_csdef(crsName.c_str());
  if (definition == nullptr) {
    throw std::runtime_error("CS_csdef failed for " + crsName);
  }

  BBox bbox = {definition->ll_min[0], definition->ll_min[1], definition->ll_max[0], definition->ll_max[1]};
  CS_free(definition);

  if (!std::isfinite(bbox.west) || !std::isfinite(bbox.south) || !std::isfinite(bbox.east) ||
      !std::isfinite(bbox.north)) {
    throw std::runtime_error("CS-MAP extent for " + crsName + " contains a non-finite coordinate");
  }

  if (bbox.west == 0.0 && bbox.south == 0.0 && bbox.east == 0.0 && bbox.north == 0.0) {
    throw std::runtime_error("CS-MAP extent for " + crsName + " is empty");
  }

  return bbox;
}

static Coord transformWithProj(PJ* transform, Coord input) {
  proj_errno_reset(transform);
  PJ_COORD output = proj_trans(transform, PJ_FWD, proj_coord(input.x, input.y, 0.0, 0.0));
  int err = proj_errno(transform);
  if (err != 0) {
    throw std::runtime_error(std::string("PROJ transform failed: ") + proj_errno_string(err));
  }
  if (!std::isfinite(output.xy.x) || !std::isfinite(output.xy.y)) {
    throw std::runtime_error("PROJ returned a non-finite coordinate");
  }
  return {output.xy.x, output.xy.y};
}

static BBox extentWithProj(PJ_CONTEXT* context, const std::string& crsName) {
  PJ* crs = proj_create(context, crsName.c_str());
  if (crs == nullptr) {
    throw std::runtime_error("proj_create failed for " + crsName);
  }

  BBox bbox = {};
  const char* areaName = nullptr;
  int status = proj_get_area_of_use(context, crs, &bbox.west, &bbox.south, &bbox.east, &bbox.north, &areaName);
  proj_destroy(crs);

  if (status == 0) {
    throw std::runtime_error("proj_get_area_of_use failed for " + crsName);
  }

  if (!std::isfinite(bbox.west) || !std::isfinite(bbox.south) || !std::isfinite(bbox.east) ||
      !std::isfinite(bbox.north)) {
    throw std::runtime_error("PROJ extent for " + crsName + " contains a non-finite coordinate");
  }

  return bbox;
}

static PJ* createTransform(PJ_CONTEXT* context, const TestCase& testCase) {
  PJ* raw = proj_create_crs_to_crs(context, testCase.projSource.c_str(), testCase.projTarget.c_str(), nullptr);
  if (raw == nullptr) {
    throw std::runtime_error("proj_create_crs_to_crs failed for " + testCase.projSource + " -> " +
                             testCase.projTarget);
  }

  PJ* normalized = proj_normalize_for_visualization(context, raw);
  proj_destroy(raw);
  if (normalized == nullptr) {
    throw std::runtime_error("proj_normalize_for_visualization failed");
  }

  return normalized;
}

static std::vector<TestCase> testCases() {
  return {
      {
          "wgs84_web_mercator_forward",
          "LL84",
          "WGS84.PseudoMercator",
          "EPSG:4326",
          "EPSG:3857",
          "m",
          0.001,
          {
              {"Philadelphia", {-75.165222, 39.952583}},
              {"Denver", {-104.990250, 39.739236}},
              {"London", {-0.127600, 51.507200}},
              {"Sydney", {151.209300, -33.868800}},
              {"High latitude", {0.0, 85.0}},
          },
      },
      {
          "wgs84_web_mercator_inverse",
          "WGS84.PseudoMercator",
          "LL84",
          "EPSG:3857",
          "EPSG:4326",
          "deg",
          1e-9,
          {
              {"Origin", {0.0, 0.0}},
              {"Philadelphia", {-8367354.238, 4859054.161}},
              {"London", {-14204.367, 6711506.705}},
              {"Sydney", {16832542.279, -4011198.647}},
          },
      },
      {
          "nad83_utm18_forward",
          "LL83",
          "UTM83-18",
          "EPSG:4269",
          "EPSG:26918",
          "m",
          0.001,
          {
              {"Philadelphia", {-75.165222, 39.952583}},
              {"New York", {-74.006000, 40.712800}},
              {"Northern VA", {-77.436000, 37.540700}},
          },
      },
      {
          "nad83_utm18_inverse",
          "UTM83-18",
          "LL83",
          "EPSG:26918",
          "EPSG:4269",
          "deg",
          1e-9,
          {
              {"Philadelphia", {486000.0, 4423000.0}},
              {"New York", {583000.0, 4507000.0}},
              {"Northern VA", {284000.0, 4157000.0}},
          },
      },
      {
          "nad83_pennsylvania_south_forward",
          "LL83",
          "PA83-S",
          "EPSG:4269",
          "EPSG:32129",
          "m",
          0.01,
          {
              {"Philadelphia", {-75.165222, 39.952583}},
              {"Harrisburg", {-76.886700, 40.273200}},
              {"Pittsburgh", {-79.995900, 40.440600}},
          },
      },
      {
          "nad83_colorado_central_forward",
          "LL83",
          "CO83-C",
          "EPSG:4269",
          "EPSG:26954",
          "m",
          0.01,
          {
              {"Denver", {-104.990250, 39.739236}},
              {"Boulder", {-105.270500, 40.015000}},
              {"Grand Junction", {-108.550600, 39.063900}},
          },
      },
      {
          "nad83_california_zone_iii_forward",
          "LL83",
          "CA83-III",
          "EPSG:4269",
          "EPSG:26943",
          "m",
          0.01,
          {
              {"San Francisco", {-122.419400, 37.774900}},
              {"Sacramento", {-121.494400, 38.581600}},
              {"Oakland", {-122.271100, 37.804400}},
          },
      },
  };
}

static std::vector<ExtentCase> extentCases() {
  return {
      {"wgs84_geographic_extent", "LL84", "EPSG:4326", 1e-9},
      {"wgs84_web_mercator_extent", "WGS84.PseudoMercator", "EPSG:3857", 1e-9},
      {"nad83_utm18_extent", "UTM83-18", "EPSG:26918", 1e-9},
      {"nad83_pennsylvania_south_extent", "PA83-S", "EPSG:32129", 1e-9},
      {"nad83_colorado_central_extent", "CO83-C", "EPSG:26954", 1e-9},
      {"nad83_california_zone_iii_extent", "CA83-III", "EPSG:26943", 1e-9},
  };
}

static bool containsExtent(const BBox& outer, const BBox& inner, double toleranceDegrees) {
  return outer.west <= inner.west + toleranceDegrees && outer.south <= inner.south + toleranceDegrees &&
         outer.east + toleranceDegrees >= inner.east && outer.north + toleranceDegrees >= inner.north;
}

static bool sameExtent(const BBox& lhs, const BBox& rhs, double toleranceDegrees) {
  return std::fabs(lhs.west - rhs.west) <= toleranceDegrees &&
         std::fabs(lhs.south - rhs.south) <= toleranceDegrees &&
         std::fabs(lhs.east - rhs.east) <= toleranceDegrees &&
         std::fabs(lhs.north - rhs.north) <= toleranceDegrees;
}

static TestResult runTestCase(PJ_CONTEXT* context, const TestCase& testCase) {
  TestResult result;
  PJ* transform = createTransform(context, testCase);

  std::cout << "case " << testCase.name << " (" << testCase.csmapSource << " -> " << testCase.csmapTarget
            << " vs " << testCase.projSource << " -> " << testCase.projTarget << ")\n";

  for (const Sample& sample : testCase.samples) {
    result.assertions += 1;

    try {
      Coord csmap = transformWithCsMap(testCase, sample.input);
      Coord proj = transformWithProj(transform, sample.input);
      const double delta = std::hypot(csmap.x - proj.x, csmap.y - proj.y);
      const bool ok = delta <= testCase.tolerance;

      std::cout << "  " << (ok ? "ok  " : "FAIL") << " " << std::left << std::setw(16) << sample.name
                << std::right << " delta=" << std::setprecision(12) << delta << " " << testCase.units
                << " tolerance=" << testCase.tolerance << " " << testCase.units << "\n";

      if (!ok) {
        result.failures += 1;
        std::cout << "       input=(" << sample.input.x << ", " << sample.input.y << ")"
                  << " csmap=(" << csmap.x << ", " << csmap.y << ")"
                  << " proj=(" << proj.x << ", " << proj.y << ")\n";
      }
    } catch (const std::exception& error) {
      result.failures += 1;
      std::cout << "  FAIL " << sample.name << " error=" << error.what() << "\n";
    }
  }

  proj_destroy(transform);
  return result;
}

static TestResult runExtentCase(PJ_CONTEXT* context, const ExtentCase& extentCase) {
  TestResult result;
  result.assertions += 1;

  std::cout << "extent " << extentCase.name << " (" << extentCase.csmapCrs << " vs " << extentCase.projCrs
            << ")\n";

  try {
    BBox csmap = extentWithCsMap(extentCase.csmapCrs);
    BBox proj = extentWithProj(context, extentCase.projCrs);

    if (proj.west > proj.east) {
      throw std::runtime_error("PROJ extent crosses the antimeridian; split-range comparison is not implemented");
    }
    if (csmap.west > csmap.east) {
      throw std::runtime_error("CS-MAP extent crosses the antimeridian; split-range comparison is not implemented");
    }

    const bool same = sameExtent(csmap, proj, extentCase.toleranceDegrees);
    const bool containsProj = containsExtent(csmap, proj, extentCase.toleranceDegrees);
    if (!same) {
      result.differences += 1;
    }

    std::cout << "  " << (same ? "same" : "DIFF") << " contains_proj_bbox=" << (containsProj ? "yes" : "no")
              << " delta_csmap_minus_proj=[west=" << std::setprecision(12) << csmap.west - proj.west
              << ", south=" << csmap.south - proj.south << ", east=" << csmap.east - proj.east
              << ", north=" << csmap.north - proj.north << "] deg\n";

    if (!same) {
      std::cout << "       csmap=[" << csmap.west << ", " << csmap.south << ", " << csmap.east << ", "
                << csmap.north << "]"
                << " proj=[" << proj.west << ", " << proj.south << ", " << proj.east << ", " << proj.north
                << "]\n";
    }
  } catch (const std::exception& error) {
    result.failures += 1;
    std::cout << "  FAIL error=" << error.what() << "\n";
  }

  return result;
}

static void writeReportJs(PJ_CONTEXT* context, const std::string& outputPath, const std::string& csmapDictionaryDir) {
  std::ofstream out(outputPath);
  if (!out) {
    throw std::runtime_error("failed to open report file for writing: " + outputPath);
  }

  int coordinateAssertions = 0;
  int coordinateFailures = 0;
  int coordinateDifferences = 0;
  int extentAssertions = 0;
  int extentFailures = 0;
  int extentDifferences = 0;

  out << "window.CSMAP_PROJ_REPORT = {\n";
  out << "  \"csmapDictionary\": ";
  writeJsonString(out, csmapDictionaryDir);
  out << ",\n  \"projVersion\": ";
  writeJsonString(out, proj_info().version);
  out << ",\n  \"coordinateCases\": [\n";

  const std::vector<TestCase> coordinates = testCases();
  for (std::size_t caseIndex = 0; caseIndex < coordinates.size(); ++caseIndex) {
    const TestCase& testCase = coordinates[caseIndex];
    out << "    {\"name\": ";
    writeJsonString(out, testCase.name);
    out << ", \"csmapSource\": ";
    writeJsonString(out, testCase.csmapSource);
    out << ", \"csmapTarget\": ";
    writeJsonString(out, testCase.csmapTarget);
    out << ", \"projSource\": ";
    writeJsonString(out, testCase.projSource);
    out << ", \"projTarget\": ";
    writeJsonString(out, testCase.projTarget);
    out << ", \"units\": ";
    writeJsonString(out, testCase.units);
    out << ", \"tolerance\": ";
    writeJsonNumber(out, testCase.tolerance);
    out << ", \"samples\": [";

    PJ* transform = nullptr;
    try {
      transform = createTransform(context, testCase);
      for (std::size_t sampleIndex = 0; sampleIndex < testCase.samples.size(); ++sampleIndex) {
        const Sample& sample = testCase.samples[sampleIndex];
        coordinateAssertions += 1;
        if (sampleIndex != 0) {
          out << ", ";
        }

        out << "{\"name\": ";
        writeJsonString(out, sample.name);
        out << ", \"input\": ";
        writeJsonCoord(out, sample.input);

        try {
          Coord csmap = transformWithCsMap(testCase, sample.input);
          Coord proj = transformWithProj(transform, sample.input);
          const double delta = std::hypot(csmap.x - proj.x, csmap.y - proj.y);
          const bool ok = delta <= testCase.tolerance;
          if (!ok) {
            coordinateFailures += 1;
            coordinateDifferences += 1;
          }

          out << ", \"csmap\": ";
          writeJsonCoord(out, csmap);
          out << ", \"proj\": ";
          writeJsonCoord(out, proj);
          out << ", \"delta\": ";
          writeJsonNumber(out, delta);
          out << ", \"status\": ";
          writeJsonString(out, ok ? "within_tolerance" : "outside_tolerance");
        } catch (const std::exception& error) {
          coordinateFailures += 1;
          out << ", \"status\": \"error\", \"error\": ";
          writeJsonString(out, error.what());
        }

        out << "}";
      }
    } catch (const std::exception& error) {
      coordinateFailures += static_cast<int>(testCase.samples.size());
      out << "{\"name\": \"case_setup\", \"status\": \"error\", \"error\": ";
      writeJsonString(out, error.what());
      out << "}";
    }

    if (transform != nullptr) {
      proj_destroy(transform);
    }

    out << "]}";
    if (caseIndex + 1 != coordinates.size()) {
      out << ",";
    }
    out << "\n";
  }

  out << "  ],\n  \"extentCases\": [\n";
  const std::vector<ExtentCase> extents = extentCases();
  for (std::size_t caseIndex = 0; caseIndex < extents.size(); ++caseIndex) {
    const ExtentCase& extentCase = extents[caseIndex];
    extentAssertions += 1;

    out << "    {\"name\": ";
    writeJsonString(out, extentCase.name);
    out << ", \"csmapCrs\": ";
    writeJsonString(out, extentCase.csmapCrs);
    out << ", \"projCrs\": ";
    writeJsonString(out, extentCase.projCrs);
    out << ", \"toleranceDegrees\": ";
    writeJsonNumber(out, extentCase.toleranceDegrees);

    try {
      BBox csmap = extentWithCsMap(extentCase.csmapCrs);
      BBox proj = extentWithProj(context, extentCase.projCrs);
      const bool same = sameExtent(csmap, proj, extentCase.toleranceDegrees);
      const bool containsProj = containsExtent(csmap, proj, extentCase.toleranceDegrees);
      if (!same) {
        extentDifferences += 1;
      }

      out << ", \"csmap\": ";
      writeJsonBBox(out, csmap);
      out << ", \"proj\": ";
      writeJsonBBox(out, proj);
      out << ", \"deltaCsmapMinusProj\": {\"west\":";
      writeJsonNumber(out, csmap.west - proj.west);
      out << ",\"south\":";
      writeJsonNumber(out, csmap.south - proj.south);
      out << ",\"east\":";
      writeJsonNumber(out, csmap.east - proj.east);
      out << ",\"north\":";
      writeJsonNumber(out, csmap.north - proj.north);
      out << "}, \"same\": " << (same ? "true" : "false")
          << ", \"containsProjBBox\": " << (containsProj ? "true" : "false") << ", \"status\": ";
      writeJsonString(out, same ? "same" : "different");
    } catch (const std::exception& error) {
      extentFailures += 1;
      out << ", \"status\": \"error\", \"error\": ";
      writeJsonString(out, error.what());
    }

    out << "}";
    if (caseIndex + 1 != extents.size()) {
      out << ",";
    }
    out << "\n";
  }

  out << "  ],\n  \"summary\": {";
  out << "\"coordinateAssertions\": " << coordinateAssertions;
  out << ", \"coordinateFailures\": " << coordinateFailures;
  out << ", \"coordinateDifferences\": " << coordinateDifferences;
  out << ", \"extentAssertions\": " << extentAssertions;
  out << ", \"extentFailures\": " << extentFailures;
  out << ", \"extentDifferences\": " << extentDifferences;
  out << ", \"failures\": " << (coordinateFailures + extentFailures);
  out << ", \"reportedDifferences\": " << (coordinateDifferences + extentDifferences);
  out << "}\n};\n";
}

int main(int argc, char** argv) {
  const std::string csmapDictionaryDir =
      optionValue(argc, argv, "--csmap-dict", "vendor/csmap/CsMapDev/Dictionaries");
  const std::string reportJsPath = optionValue(argc, argv, "--report-js", "");

  try {
    if (CS_altdr(csmapDictionaryDir.c_str()) != 0) {
      throw std::runtime_error("CS_altdr failed for dictionary dir: " + csmapDictionaryDir);
    }

    PJ_CONTEXT* context = proj_context_create();
    if (context == nullptr) {
      throw std::runtime_error("proj_context_create failed");
    }

    std::cout << "CS-MAP dictionary: " << csmapDictionaryDir << "\n";
    std::cout << "PROJ version: " << proj_info().version << "\n\n";

    TestResult total;
    for (const TestCase& testCase : testCases()) {
      TestResult current = runTestCase(context, testCase);
      total.assertions += current.assertions;
      total.failures += current.failures;
      total.differences += current.differences;
      std::cout << "\n";
    }

    for (const ExtentCase& extentCase : extentCases()) {
      TestResult current = runExtentCase(context, extentCase);
      total.assertions += current.assertions;
      total.failures += current.failures;
      total.differences += current.differences;
      std::cout << "\n";
    }

    if (!reportJsPath.empty()) {
      writeReportJs(context, reportJsPath, csmapDictionaryDir);
      std::cout << "wrote_report_js=" << reportJsPath << "\n";
    }

    proj_context_destroy(context);
    CS_recvr();

    std::cout << "summary assertions=" << total.assertions << " failures=" << total.failures
              << " reported_differences=" << total.differences << "\n";
    return total.failures == 0 ? EXIT_SUCCESS : EXIT_FAILURE;
  } catch (const std::exception& error) {
    CS_recvr();
    std::cerr << "fatal: " << error.what() << "\n";
    return EXIT_FAILURE;
  }
}
