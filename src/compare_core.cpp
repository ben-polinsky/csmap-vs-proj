#include "compare_core.hpp"

#include <proj.h>

#include <cmath>
#include <iomanip>
#include <sstream>
#include <stdexcept>

extern "C" {
#include "cs_map.h"
}

namespace csmap_proj {

namespace {

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

void writeJsonString(std::ostream& out, const std::string& value) {
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

void writeJsonNumber(std::ostream& out, double value) {
  if (std::isfinite(value)) {
    out << std::setprecision(15) << value;
  } else {
    out << "null";
  }
}

void writeJsonCoord(std::ostream& out, const Coord& coord) {
  out << "{\"x\":";
  writeJsonNumber(out, coord.x);
  out << ",\"y\":";
  writeJsonNumber(out, coord.y);
  out << "}";
}

void writeJsonBBox(std::ostream& out, const BBox& bbox) {
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

Coord transformWithCsMap(const CompareOptions& options) {
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

Coord transformWithProj(PJ_CONTEXT* context, const CompareOptions& options) {
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

BBox extentWithCsMap(const std::string& crsName) {
  cs_Csdef_* definition = CS_csdef(crsName.c_str());
  if (definition == nullptr) {
    throw std::runtime_error("CS_csdef failed for " + crsName);
  }
  BBox bbox = {definition->ll_min[0], definition->ll_min[1], definition->ll_max[0], definition->ll_max[1]};
  CS_free(definition);
  return bbox;
}

BBox extentWithProj(PJ_CONTEXT* context, const std::string& crsName) {
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

bool containsExtent(const BBox& outer, const BBox& inner) {
  return outer.west <= inner.west && outer.south <= inner.south && outer.east >= inner.east &&
         outer.north >= inner.north;
}

}  // namespace

std::string fatalJson(const std::string& message) {
  std::ostringstream out;
  out << "{\"fatal\":";
  writeJsonString(out, message);
  out << "}";
  return out.str();
}

std::string compareToJson(const CompareOptions& options, bool* ok) {
  bool compareOk = false;

  try {
    if (CS_altdr(options.csmapDict.c_str()) != 0) {
      throw std::runtime_error("CS_altdr failed for dictionary dir: " + options.csmapDict);
    }

    PJ_CONTEXT* context = proj_context_create();
    if (context == nullptr) {
      throw std::runtime_error("proj_context_create failed");
    }
    proj_context_set_enable_network(context, 0);

    if (!options.projDataPath.empty()) {
      const char* searchPaths[] = {options.projDataPath.c_str()};
      proj_context_set_search_paths(context, 1, searchPaths);
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

    std::ostringstream out;
    out << "{\"input\":{";
    out << "\"x\":";
    writeJsonNumber(out, options.x);
    out << ",\"y\":";
    writeJsonNumber(out, options.y);
    out << "},\"csmap\":{\"source\":";
    writeJsonString(out, options.csmapSource);
    out << ",\"target\":";
    writeJsonString(out, options.csmapTarget);
    out << ",\"ok\":" << (csmapOk ? "true" : "false");
    if (csmapOk) {
      out << ",\"coord\":";
      writeJsonCoord(out, csmap);
    } else {
      out << ",\"error\":";
      writeJsonString(out, csmapError);
    }
    out << "},\"proj\":{\"source\":";
    writeJsonString(out, options.projSource);
    out << ",\"target\":";
    writeJsonString(out, options.projTarget);
    out << ",\"ok\":" << (projOk ? "true" : "false");
    if (projOk) {
      out << ",\"coord\":";
      writeJsonCoord(out, proj);
    } else {
      out << ",\"error\":";
      writeJsonString(out, projError);
    }
    out << "}";

    if (csmapOk && projOk) {
      const double delta = std::hypot(csmap.x - proj.x, csmap.y - proj.y);
      out << ",\"delta\":";
      writeJsonNumber(out, delta);
      out << ",\"deltaComponents\":{\"x\":";
      writeJsonNumber(out, csmap.x - proj.x);
      out << ",\"y\":";
      writeJsonNumber(out, csmap.y - proj.y);
      out << "}";
    }

    try {
      BBox csmapExtent = extentWithCsMap(options.csmapTarget);
      BBox projExtent = extentWithProj(context, options.projTarget);
      out << ",\"targetExtent\":{\"csmap\":";
      writeJsonBBox(out, csmapExtent);
      out << ",\"proj\":";
      writeJsonBBox(out, projExtent);
      out << ",\"deltaCsmapMinusProj\":{\"west\":";
      writeJsonNumber(out, csmapExtent.west - projExtent.west);
      out << ",\"south\":";
      writeJsonNumber(out, csmapExtent.south - projExtent.south);
      out << ",\"east\":";
      writeJsonNumber(out, csmapExtent.east - projExtent.east);
      out << ",\"north\":";
      writeJsonNumber(out, csmapExtent.north - projExtent.north);
      out << "},\"containsProjBBox\":" << (containsExtent(csmapExtent, projExtent) ? "true" : "false") << "}";
    } catch (const std::exception& error) {
      out << ",\"targetExtent\":{\"error\":";
      writeJsonString(out, error.what());
      out << "}";
    }

    out << ",\"projVersion\":";
    writeJsonString(out, proj_info().version);
    out << "}";

    proj_context_destroy(context);
    CS_recvr();
    compareOk = csmapOk && projOk;
    if (ok != nullptr) *ok = compareOk;
    return out.str();
  } catch (const std::exception& error) {
    CS_recvr();
    if (ok != nullptr) *ok = false;
    return fatalJson(error.what());
  }
}

}  // namespace csmap_proj
