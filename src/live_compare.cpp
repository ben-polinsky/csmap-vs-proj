#include <proj.h>

#include <cmath>
#include <cstdlib>
#include <cstring>
#include <iomanip>
#include <iostream>
#include <map>
#include <stdexcept>
#include <string>

extern "C" {
#include "cs_map.h"
}

struct Coord {
  double x;
  double y;
};

struct BBox {
  double west;
  double south;
  double east;
  double north;
};

struct Options {
  std::string csmapDict = "vendor/csmap/CsMapDev/Dictionaries";
  std::string csmapSource;
  std::string csmapTarget;
  std::string projSource;
  std::string projTarget;
  double x = 0.0;
  double y = 0.0;
};

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

static std::map<std::string, std::string> parseArgs(int argc, char** argv) {
  std::map<std::string, std::string> args;
  for (int i = 1; i < argc; i += 2) {
    if (i + 1 >= argc) {
      throw std::runtime_error(std::string("missing value for ") + argv[i]);
    }
    args[argv[i]] = argv[i + 1];
  }
  return args;
}

static std::string required(const std::map<std::string, std::string>& args, const std::string& name) {
  auto it = args.find(name);
  if (it == args.end() || it->second.empty()) {
    throw std::runtime_error("missing required option " + name);
  }
  return it->second;
}

static Options optionsFromArgs(int argc, char** argv) {
  const auto args = parseArgs(argc, argv);
  Options options;
  if (auto it = args.find("--csmap-dict"); it != args.end()) {
    options.csmapDict = it->second;
  }
  options.csmapSource = required(args, "--csmap-source");
  options.csmapTarget = required(args, "--csmap-target");
  options.projSource = required(args, "--proj-source");
  options.projTarget = required(args, "--proj-target");
  options.x = std::stod(required(args, "--x"));
  options.y = std::stod(required(args, "--y"));
  return options;
}

static Coord transformWithCsMap(const Options& options) {
  double coord[3] = {options.x, options.y, 0.0};
  int status = CS_cnvrt(options.csmapSource.c_str(), options.csmapTarget.c_str(), coord);
  if (status != 0) {
    throw std::runtime_error("CS-MAP returned status " + std::to_string(status));
  }
  if (!std::isfinite(coord[0]) || !std::isfinite(coord[1])) {
    throw std::runtime_error("CS-MAP returned a non-finite coordinate");
  }
  return {coord[0], coord[1]};
}

static Coord transformWithProj(PJ_CONTEXT* context, const Options& options) {
  PJ* raw = proj_create_crs_to_crs(context, options.projSource.c_str(), options.projTarget.c_str(), nullptr);
  if (raw == nullptr) {
    throw std::runtime_error("proj_create_crs_to_crs failed");
  }

  PJ* transform = proj_normalize_for_visualization(context, raw);
  proj_destroy(raw);
  if (transform == nullptr) {
    throw std::runtime_error("proj_normalize_for_visualization failed");
  }

  proj_errno_reset(transform);
  PJ_COORD output = proj_trans(transform, PJ_FWD, proj_coord(options.x, options.y, 0.0, 0.0));
  int err = proj_errno(transform);
  proj_destroy(transform);

  if (err != 0) {
    throw std::runtime_error(std::string("PROJ transform failed: ") + proj_errno_string(err));
  }
  if (!std::isfinite(output.xy.x) || !std::isfinite(output.xy.y)) {
    throw std::runtime_error("PROJ returned a non-finite coordinate");
  }
  return {output.xy.x, output.xy.y};
}

static BBox extentWithCsMap(const std::string& crsName) {
  cs_Csdef_* definition = CS_csdef(crsName.c_str());
  if (definition == nullptr) {
    throw std::runtime_error("CS_csdef failed for " + crsName);
  }
  BBox bbox = {definition->ll_min[0], definition->ll_min[1], definition->ll_max[0], definition->ll_max[1]};
  CS_free(definition);
  return bbox;
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
  return bbox;
}

static bool containsExtent(const BBox& outer, const BBox& inner) {
  return outer.west <= inner.west && outer.south <= inner.south && outer.east >= inner.east &&
         outer.north >= inner.north;
}

int main(int argc, char** argv) {
  try {
    const Options options = optionsFromArgs(argc, argv);
    if (CS_altdr(options.csmapDict.c_str()) != 0) {
      throw std::runtime_error("CS_altdr failed for dictionary dir: " + options.csmapDict);
    }

    PJ_CONTEXT* context = proj_context_create();
    if (context == nullptr) {
      throw std::runtime_error("proj_context_create failed");
    }

    bool csmapOk = false;
    bool projOk = false;
    Coord csmap = {};
    Coord proj = {};
    std::string csmapError;
    std::string projError;

    try {
      csmap = transformWithCsMap(options);
      csmapOk = true;
    } catch (const std::exception& error) {
      csmapError = error.what();
    }

    try {
      proj = transformWithProj(context, options);
      projOk = true;
    } catch (const std::exception& error) {
      projError = error.what();
    }

    std::cout << "{\"input\":{";
    std::cout << "\"x\":";
    writeJsonNumber(std::cout, options.x);
    std::cout << ",\"y\":";
    writeJsonNumber(std::cout, options.y);
    std::cout << "},\"csmap\":{\"source\":";
    writeJsonString(std::cout, options.csmapSource);
    std::cout << ",\"target\":";
    writeJsonString(std::cout, options.csmapTarget);
    std::cout << ",\"ok\":" << (csmapOk ? "true" : "false");
    if (csmapOk) {
      std::cout << ",\"coord\":";
      writeJsonCoord(std::cout, csmap);
    } else {
      std::cout << ",\"error\":";
      writeJsonString(std::cout, csmapError);
    }
    std::cout << "},\"proj\":{\"source\":";
    writeJsonString(std::cout, options.projSource);
    std::cout << ",\"target\":";
    writeJsonString(std::cout, options.projTarget);
    std::cout << ",\"ok\":" << (projOk ? "true" : "false");
    if (projOk) {
      std::cout << ",\"coord\":";
      writeJsonCoord(std::cout, proj);
    } else {
      std::cout << ",\"error\":";
      writeJsonString(std::cout, projError);
    }
    std::cout << "}";

    if (csmapOk && projOk) {
      const double delta = std::hypot(csmap.x - proj.x, csmap.y - proj.y);
      std::cout << ",\"delta\":";
      writeJsonNumber(std::cout, delta);
      std::cout << ",\"deltaComponents\":{\"x\":";
      writeJsonNumber(std::cout, csmap.x - proj.x);
      std::cout << ",\"y\":";
      writeJsonNumber(std::cout, csmap.y - proj.y);
      std::cout << "}";
    }

    try {
      BBox csmapExtent = extentWithCsMap(options.csmapTarget);
      BBox projExtent = extentWithProj(context, options.projTarget);
      std::cout << ",\"targetExtent\":{\"csmap\":";
      writeJsonBBox(std::cout, csmapExtent);
      std::cout << ",\"proj\":";
      writeJsonBBox(std::cout, projExtent);
      std::cout << ",\"deltaCsmapMinusProj\":{\"west\":";
      writeJsonNumber(std::cout, csmapExtent.west - projExtent.west);
      std::cout << ",\"south\":";
      writeJsonNumber(std::cout, csmapExtent.south - projExtent.south);
      std::cout << ",\"east\":";
      writeJsonNumber(std::cout, csmapExtent.east - projExtent.east);
      std::cout << ",\"north\":";
      writeJsonNumber(std::cout, csmapExtent.north - projExtent.north);
      std::cout << "},\"containsProjBBox\":" << (containsExtent(csmapExtent, projExtent) ? "true" : "false")
                << "}";
    } catch (const std::exception& error) {
      std::cout << ",\"targetExtent\":{\"error\":";
      writeJsonString(std::cout, error.what());
      std::cout << "}";
    }

    std::cout << ",\"projVersion\":";
    writeJsonString(std::cout, proj_info().version);
    std::cout << "}\n";

    proj_context_destroy(context);
    CS_recvr();
    return (csmapOk && projOk) ? EXIT_SUCCESS : EXIT_FAILURE;
  } catch (const std::exception& error) {
    CS_recvr();
    std::cout << "{\"fatal\":";
    writeJsonString(std::cout, error.what());
    std::cout << "}\n";
    return EXIT_FAILURE;
  }
}
